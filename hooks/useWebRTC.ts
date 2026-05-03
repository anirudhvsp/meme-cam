/**
 * useWebRTC
 * Manages the RTCPeerConnection for peer-to-peer video.
 * The "host" creates the offer; the "guest" answers.
 * ICE candidates are exchanged via the signaling channel.
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

  const createPeerConnection = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        onSignal({ type: "ice_candidate", candidate: ev.candidate.toJSON() });
      }
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (stream) setRemoteStream(stream);
    };

    // Add local tracks
    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    return pc;
  }, [localStream, onSignal]);

  // Called when we're ready to start (both peers in room)
  const startAsHost = useCallback(async () => {
    const pc = createPeerConnection();
    const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
    await pc.setLocalDescription(offer);
    onSignal({ type: "offer", sdp: offer.sdp, sdpType: offer.type });
  }, [createPeerConnection, onSignal]);

  const handleOffer = useCallback(async (sdp: RTCSessionDescriptionInit) => {
    const pc = createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    onSignal({ type: "answer", sdp: answer.sdp, sdpType: answer.type });
  }, [createPeerConnection, onSignal]);

  const handleAnswer = useCallback(async (sdp: RTCSessionDescriptionInit) => {
    const pc = pcRef.current;
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
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
