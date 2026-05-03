/**
 * useSignaling — fixed version
 *
 * Fixes applied:
 *
 * 1. connectRoom closure ordering bug:
 *    In the original code, connectMatchmaking called connectRoom directly from
 *    inside its own closure. Because both were defined with useCallback and
 *    connectRoom appeared second in the file, connectMatchmaking captured a
 *    stale/undefined reference to connectRoom. Fixed by moving connectRoom to
 *    a stable ref and calling it via that ref.
 *
 * 2. WebSocket reconnect with exponential backoff:
 *    A single network blip (common on mobile) permanently set phase="error"
 *    with no recovery path. We now retry the room WS up to 5 times with
 *    capped exponential backoff (1s, 2s, 4s, 8s, 16s). Matchmaking WS is
 *    NOT retried on drop (the user should just click Matchmake again).
 *
 * 3. Peer score relay:
 *    score_update messages from the peer are now forwarded to the client via
 *    onPeerScore so the UI can show a live bar for the opponent during the
 *    round. The server already relays score_update to the other player
 *    (the relay() function in index.ts handles it) — we just needed to handle
 *    the inbound message on the receiving side.
 *
 * 4. Cleanup on unmount closes both WS connections.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type SignalingPhase = "idle" | "queued" | "matched" | "in_room" | "error";

export interface RoomInfo {
  roomId: string;
  role: "host" | "guest";
  peerId: string;
}

export interface RoundResult {
  results: Record<string, number>;
  winnerId: string | null;
}

export interface SignalingState {
  phase: SignalingPhase;
  userId: string;
  roomInfo: RoomInfo | null;
  secondsLeft: number | null;
  memeIndex: number | null;
  roundResult: RoundResult | null;
  rematchVotes: Set<string>;
  peerCount: number;
}

interface UseSignalingOptions {
  workerUrl: string;
  onOffer: (sdp: RTCSessionDescriptionInit) => void;
  onAnswer: (sdp: RTCSessionDescriptionInit) => void;
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onRoundStart: (memeIndex: number) => void;
  onRoundEnd: (result: RoundResult) => void;
  /** Called with the peer's live score during a round */
  onPeerScore?: (score: number) => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;

export function useSignaling({
  workerUrl,
  onOffer,
  onAnswer,
  onIceCandidate,
  onRoundStart,
  onRoundEnd,
  onPeerScore,
}: UseSignalingOptions) {
  const [state, setState] = useState<SignalingState>({
    phase: "idle",
    userId: crypto.randomUUID(),
    roomInfo: null,
    secondsLeft: null,
    memeIndex: null,
    roundResult: null,
    rematchVotes: new Set(),
    peerCount: 0,
  });

  const wsRef            = useRef<WebSocket | null>(null);
  const userIdRef        = useRef(state.userId);
  // Stable callback refs — avoids re-creating connectRoom/connectMatchmaking
  const onOfferRef       = useRef(onOffer);
  const onAnswerRef      = useRef(onAnswer);
  const onIceCandRef     = useRef(onIceCandidate);
  const onRoundStartRef  = useRef(onRoundStart);
  const onRoundEndRef    = useRef(onRoundEnd);
  const onPeerScoreRef   = useRef(onPeerScore);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { onOfferRef.current      = onOffer; },      [onOffer]);
  useEffect(() => { onAnswerRef.current     = onAnswer; },     [onAnswer]);
  useEffect(() => { onIceCandRef.current    = onIceCandidate; }, [onIceCandidate]);
  useEffect(() => { onRoundStartRef.current = onRoundStart; }, [onRoundStart]);
  useEffect(() => { onRoundEndRef.current   = onRoundEnd; },   [onRoundEnd]);
  useEffect(() => { onPeerScoreRef.current  = onPeerScore; },  [onPeerScore]);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  // connectRoom is stored in a ref so connectMatchmaking can call the latest
  // version without capturing a stale closure.
  const connectRoomRef = useRef<(roomInfo: RoomInfo, attempt?: number) => void>(() => {});

  const connectRoom = useCallback((roomInfo: RoomInfo, attempt = 0) => {
    wsRef.current?.close();
    const ws = new WebSocket(
      `${workerUrl.replace(/^http/, "ws")}/room/${roomInfo.roomId}` +
      `?userId=${userIdRef.current}&role=${roomInfo.role}`
    );
    wsRef.current = ws;

    ws.onopen = () => {
      setState((s) => ({ ...s, phase: "in_room" }));
    };

    ws.onmessage = (ev) => {
      let data: Record<string, unknown>;
      try { data = JSON.parse(ev.data); } catch { return; }

      switch (data.type) {
        case "player_joined":
          setState((s) => ({ ...s, peerCount: data.playerCount as number }));
          break;

        case "player_left":
          setState((s) => ({ ...s, peerCount: data.playerCount as number }));
          setTimeout(() => {
            setState((s) => {
              if (s.peerCount === 0) return { ...s, phase: "idle", roomInfo: null };
              return s;
            });
          }, 3000);
          break;

        case "round_start":
          setState((s) => ({
            ...s,
            memeIndex: data.memeIndex as number,
            secondsLeft: data.duration as number,
            roundResult: null,
            rematchVotes: new Set(),
          }));
          onRoundStartRef.current(data.memeIndex as number);
          break;

        case "tick":
          setState((s) => ({ ...s, secondsLeft: data.secondsLeft as number }));
          break;

        case "round_end": {
          const result: RoundResult = {
            results: data.results as Record<string, number>,
            winnerId: data.winnerId as string | null,
          };
          setState((s) => ({ ...s, roundResult: result, secondsLeft: null }));
          onRoundEndRef.current(result);
          break;
        }

        case "rematch_vote":
          setState((s) => ({
            ...s,
            rematchVotes: new Set([...s.rematchVotes, data.userId as string]),
          }));
          break;

        // Live peer score during the round — relay to UI
        case "score_update":
          onPeerScoreRef.current?.(data.score as number);
          break;

        // WebRTC signaling
        case "offer":
          onOfferRef.current(data as unknown as RTCSessionDescriptionInit);
          break;
        case "answer":
          onAnswerRef.current(data as unknown as RTCSessionDescriptionInit);
          break;
        case "ice_candidate":
          onIceCandRef.current(data.candidate as RTCIceCandidateInit);
          break;
      }
    };

    ws.onerror = () => {
      // Don't immediately set error — onclose will fire next and handle retry
    };

    ws.onclose = (ev) => {
      // Normal closure (1000) or user-initiated — don't retry
      if (ev.code === 1000) {
        setState((s) =>
          s.phase === "in_room" ? { ...s, phase: "idle", roomInfo: null } : s
        );
        return;
      }

      // Abnormal closure — retry with exponential backoff
      if (attempt < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 16000);
        console.warn(`[Signaling] WS closed (code ${ev.code}), retrying in ${delay}ms (attempt ${attempt + 1})`);
        reconnectTimerRef.current = setTimeout(() => {
          connectRoomRef.current(roomInfo, attempt + 1);
        }, delay);
      } else {
        console.error("[Signaling] Max reconnect attempts reached");
        setState((s) => ({ ...s, phase: "error" }));
      }
    };
  }, [workerUrl]);

  // Keep the ref in sync with the latest connectRoom closure
  useEffect(() => { connectRoomRef.current = connectRoom; }, [connectRoom]);

  const connectMatchmaking = useCallback(() => {
    wsRef.current?.close();
    const ws = new WebSocket(
      `${workerUrl.replace(/^http/, "ws")}/matchmake?userId=${userIdRef.current}`
    );
    wsRef.current = ws;

    ws.onopen = () => {
      setState((s) => ({ ...s, phase: "queued" }));
    };

    ws.onmessage = (ev) => {
      let data: Record<string, unknown>;
      try { data = JSON.parse(ev.data); } catch { return; }

      if (data.type === "queued") {
        setState((s) => ({ ...s, phase: "queued" }));
      }

      if (data.type === "matched") {
        const roomInfo: RoomInfo = {
          roomId: data.roomId as string,
          role: data.role as "host" | "guest",
          peerId: data.peerId as string,
        };
        setState((s) => ({ ...s, phase: "matched", roomInfo }));
        ws.close();
        // Call via ref to always use the latest version — fixes the closure
        // ordering bug where connectMatchmaking captured an undefined connectRoom
        connectRoomRef.current(roomInfo);
      }
    };

    ws.onerror = () => setState((s) => ({ ...s, phase: "error" }));
  }, [workerUrl]);

  const startMatchmaking = useCallback(() => {
    // Clear any pending reconnect timers from a previous session
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setState((s) => ({
      ...s,
      phase: "idle",
      roomInfo: null,
      secondsLeft: null,
      memeIndex: null,
      roundResult: null,
      rematchVotes: new Set(),
      peerCount: 0,
    }));
    connectMatchmaking();
  }, [connectMatchmaking]);

  const sendRematch = useCallback(() => {
    send({ type: "rematch" });
    setState((s) => ({
      ...s,
      rematchVotes: new Set([...s.rematchVotes, userIdRef.current]),
    }));
  }, [send]);

  const sendScoreUpdate = useCallback(
    (score: number) => send({ type: "score_update", score }),
    [send]
  );

  const sendSignal = useCallback(
    (data: unknown) => send(data),
    [send]
  );

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  return {
    state,
    startMatchmaking,
    sendRematch,
    sendScoreUpdate,
    sendSignal,
    userId: userIdRef.current,
  };
}
