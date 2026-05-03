/**
 * useWebRTC
 * Manages the RTCPeerConnection for peer-to-peer video.
 * The "host" creates the offer; the "guest" answers.
 * ICE candidates are exchanged via the signaling channel.
 *
 * Fixes:
 *  - localStream stored in a ref so createPeerConnection always sees the current
 *    stream, not a stale closure value (was causing no local tracks being sent)
 *  - SDP message fields: worker sends { type, sdp, sdpType } where `type` is the
 *    message kind ("offer"/"answer") and `sdpType` is the RTCSessionDescription type.
 *    We now explicitly construct the RTCSessionDescriptionInit correctly.
 *  - remoteStream built from ev.streams[0] when available, falling back to
 *    a manually constructed MediaStream. Using ev.streams[0] is more reliable
 *    across browsers and avoids a blank video on mobile Safari.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

interface UseWebRTCOptions {
  role: "host" | "guest" | null;
  localStream: MediaStream | null;
  onSignal: (data: unknown) => void;
}

export function useWebRTC({ role, localStream, onSignal }: UseWebRTCOptions) {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  // Keep localStream in a ref so callbacks always read the latest value
  // without needing to be recreated every time the stream changes.
  const localStreamRef = useRef<MediaStream | null>(localStream);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);

  const onSignalRef = useRef(onSignal);
  useEffect(() => { onSignalRef.current = onSignal; }, [onSignal]);

  const createPeerConnection = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        onSignalRef.current({ type: "ice_candidate", candidate: ev.candidate.toJSON() });
      }
    };

    pc.ontrack = (ev) => {
      // Prefer ev.streams[0] — it's the complete, already-assembled MediaStream
      // that the browser manages. Constructing a new MediaStream per-track can
      // produce a stream that never actually plays on mobile Safari.
      const stream = ev.streams?.[0] ?? new MediaStream([ev.track]);
      setRemoteStream(stream);
    };

    // Read stream from ref so we always get the current value, not a closure snapshot
    const stream = localStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }
    }

    return pc;
  }, []); // no deps — reads everything from refs

  const startAsHost = useCallback(async () => {
    const pc = createPeerConnection();
    const offer = await pc.createOffer({
      offerToReceiveVideo: true,
      offerToReceiveAudio: false,
    });
    await pc.setLocalDescription(offer);
    onSignalRef.current({ type: "offer", sdp: offer.sdp, sdpType: offer.type });
  }, [createPeerConnection]);

  const handleOffer = useCallback(
    async (msg: any) => {
      const pc = createPeerConnection();
      // Worker sends { type: "offer", sdp: "...", sdpType: "offer" }
      // RTCSessionDescriptionInit needs { type, sdp } where type is the SDP kind
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: (msg.sdpType ?? msg.type) as RTCSdpType,
        sdp: msg.sdp,
      }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      onSignalRef.current({ type: "answer", sdp: answer.sdp, sdpType: answer.type });
    },
    [createPeerConnection]
  );

  const handleAnswer = useCallback(async (msg: any) => {
    const pc = pcRef.current;
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription({
      type: (msg.sdpType ?? msg.type) as RTCSdpType,
      sdp: msg.sdp,
    }));
  }, []);

  const handleIceCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    const pc = pcRef.current;
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn("ICE candidate error", e);
    }
  }, []);

  useEffect(() => {
    return () => {
      pcRef.current?.close();
    };
  }, []);

  return {
    remoteStream,
    startAsHost,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
  };
}
