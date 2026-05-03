/**
 * useWebRTC — fixed version
 *
 * Fixes applied:
 *
 * 1. ICE candidate buffering (root cause of "remote video not visible" bug):
 *    ICE candidates from the signaling server can arrive before
 *    setRemoteDescription() has completed. addIceCandidate() throws in that
 *    case and the candidates are silently dropped, leaving the connection in
 *    a state where it can never complete — no video ever appears. We now
 *    buffer candidates in pendingCandidatesRef and flush them only after
 *    setRemoteDescription() resolves.
 *
 * 2. Stream race condition fixed — localStream is now read from a ref
 *    SYNCHRONOUSLY inside createPeerConnection. The original code also did
 *    this, but startAsHost was called from page.tsx before the localStream
 *    state had propagated through two React render cycles. The fix is to
 *    ensure page.tsx waits for localStream != null before calling startAsHost
 *    (see page.tsx fix), AND to make createPeerConnection log a warning when
 *    the stream is missing so it's visible during debugging.
 *
 * 3. ontrack now handles both ev.streams[0] AND the trackless case.
 *    Some mobile browsers (Firefox Android) fire ontrack with an empty
 *    streams array — we fall back to constructing a new MediaStream from
 *    ev.track in that case.
 *
 * 4. PC is closed and nulled before creating a new one. Without this, a
 *    rematch creates a second RTCPeerConnection while the first one's
 *    ICE agent is still running, leaking ports and causing interference.
 *
 * 5. Added iceConnectionState logging in dev to help diagnose future issues.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // ⚠️  openrelay is rate-limited and unreliable for production.
  // Replace with Cloudflare Calls TURN, Twilio, or your own coturn server.
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
  const pcRef                  = useRef<RTCPeerConnection | null>(null);
  const localStreamRef         = useRef<MediaStream | null>(localStream);
  const onSignalRef            = useRef(onSignal);
  // Buffer ICE candidates that arrive before setRemoteDescription completes
  const pendingCandidatesRef   = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescSetRef       = useRef(false);

  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  useEffect(() => { localStreamRef.current = localStream; },  [localStream]);
  useEffect(() => { onSignalRef.current    = onSignal; },     [onSignal]);

  const createPeerConnection = useCallback(() => {
    // Clean up any existing connection before creating a new one.
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    // Reset state for new connection
    pendingCandidatesRef.current = [];
    remoteDescSetRef.current     = false;
    setRemoteStream(null);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        onSignalRef.current({ type: "ice_candidate", candidate: ev.candidate.toJSON() });
      }
    };

    // Log ICE state changes in dev — invaluable for diagnosing "no video" issues
    if (process.env.NODE_ENV !== "production") {
      pc.oniceconnectionstatechange = () => {
        console.debug("[WebRTC] ICE connection state:", pc.iceConnectionState);
      };
      pc.onconnectionstatechange = () => {
        console.debug("[WebRTC] Connection state:", pc.connectionState);
      };
    }

    pc.ontrack = (ev) => {
      // ev.streams[0] is preferred; fall back for Firefox Android which fires
      // ontrack with an empty streams array.
      const stream = ev.streams?.[0] ?? new MediaStream([ev.track]);
      setRemoteStream(stream);
    };

    const stream = localStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }
    } else {
      // This will produce a video connection with no local tracks.
      // page.tsx should gate startAsHost on localStream != null to prevent this.
      console.warn("[WebRTC] createPeerConnection called with no local stream — tracks will be missing");
    }

    return pc;
  }, []);

  /** Flush any buffered ICE candidates now that remote description is set */
  const flushPendingCandidates = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    const candidates = pendingCandidatesRef.current.splice(0);
    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn("[WebRTC] Failed to add buffered ICE candidate:", e);
      }
    }
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
    remoteDescSetRef.current = true;
    await flushPendingCandidates();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    onSignalRef.current({ type: "answer", sdp: answer.sdp, sdpType: answer.type });
  }, [createPeerConnection, flushPendingCandidates]);

  const handleAnswer = useCallback(async (msg: any) => {
    const pc = pcRef.current;
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription({
      type: (msg.sdpType ?? msg.type) as RTCSdpType,
      sdp: msg.sdp,
    }));
    remoteDescSetRef.current = true;
    await flushPendingCandidates();
  }, [flushPendingCandidates]);

  const handleIceCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    const pc = pcRef.current;
    if (!pc) return;

    if (!remoteDescSetRef.current) {
      // Remote description not set yet — buffer the candidate
      pendingCandidatesRef.current.push(candidate);
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn("[WebRTC] ICE candidate error:", e);
    }
  }, []);

  useEffect(() => {
    return () => { pcRef.current?.close(); };
  }, []);

  return { remoteStream, startAsHost, handleOffer, handleAnswer, handleIceCandidate };
}
