/**
 * useWebRTC
 *
 * Changes from original:
 * - Added TURN server support (required for mobile-to-mobile behind carrier NAT/CGNAT).
 *   STUN alone cannot traverse symmetric NAT — both mobile devices need a TURN relay.
 *   Using open.relay.metered.ca free TURN servers as defaults; replace with your own
 *   for production (Cloudflare Calls, Twilio, or self-hosted coturn).
 * - localStream stored in a ref so createPeerConnection always sees the current stream.
 * - SDP fields correctly mapped (worker sends sdpType, not type, for SDP kind).
 * - ontrack uses ev.streams[0] — more reliable than constructing a new MediaStream.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // Free TURN relay — handles mobile-to-mobile (symmetric NAT / carrier CGNAT).
  // Replace with a paid/self-hosted TURN server for production reliability.
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

interface UseWebRTCOptions {
  role: "host" | "guest" | null;
  localStream: MediaStream | null;
  onSignal: (data: unknown) => void;
}

export function useWebRTC({ role, localStream, onSignal }: UseWebRTCOptions) {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const localStreamRef = useRef<MediaStream | null>(localStream);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);

  const onSignalRef = useRef(onSignal);
  useEffect(() => { onSignalRef.current = onSignal; }, [onSignal]);

  const createPeerConnection = useCallback(() => {
    if (pcRef.current) pcRef.current.close();

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        onSignalRef.current({ type: "ice_candidate", candidate: ev.candidate.toJSON() });
      }
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams?.[0] ?? new MediaStream([ev.track]);
      setRemoteStream(stream);
    };

    const stream = localStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }
    }

    return pc;
  }, []);

  const startAsHost = useCallback(async () => {
    const pc = createPeerConnection();
    const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
    await pc.setLocalDescription(offer);
    onSignalRef.current({ type: "offer", sdp: offer.sdp, sdpType: offer.type });
  }, [createPeerConnection]);

  const handleOffer = useCallback(async (msg: any) => {
    const pc = createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription({
      type: (msg.sdpType ?? msg.type) as RTCSdpType,
      sdp: msg.sdp,
    }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    onSignalRef.current({ type: "answer", sdp: answer.sdp, sdpType: answer.type });
  }, [createPeerConnection]);

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
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.warn("ICE candidate error", e); }
  }, []);

  useEffect(() => { return () => { pcRef.current?.close(); }; }, []);

  return { remoteStream, startAsHost, handleOffer, handleAnswer, handleIceCandidate };
}
