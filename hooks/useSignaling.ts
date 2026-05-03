/**
 * useSignaling
 * Manages the WebSocket connection to the Cloudflare Worker.
 * Handles both the matchmaking phase and the in-room signaling phase.
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
}

export function useSignaling({
  workerUrl,
  onOffer,
  onAnswer,
  onIceCandidate,
  onRoundStart,
  onRoundEnd,
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

  const wsRef = useRef<WebSocket | null>(null);
  const userIdRef = useRef(state.userId);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

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
        connectRoom(roomInfo);
      }
    };

    ws.onerror = () => setState((s) => ({ ...s, phase: "error" }));
  }, [workerUrl]);

  const connectRoom = useCallback((roomInfo: RoomInfo) => {
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
          setState((s) => ({
            ...s,
            peerCount: data.playerCount as number
          }));

          setTimeout(() => {
            setState((s) => {
              if (s.peerCount === 0) {
                return { ...s, phase: "idle", roomInfo: null };
              }
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
          onRoundStart(data.memeIndex as number);
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
          onRoundEnd(result);
          break;
        }
        case "rematch_vote":
          setState((s) => ({
            ...s,
            rematchVotes: new Set([...s.rematchVotes, data.userId as string]),
          }));
          break;
        // WebRTC signaling
        case "offer":
          onOffer(data as unknown as RTCSessionDescriptionInit);
          break;
        case "answer":
          onAnswer(data as unknown as RTCSessionDescriptionInit);
          break;
        case "ice_candidate":
          onIceCandidate(data.candidate as RTCIceCandidateInit);
          break;
      }
    };

    ws.onerror = () => setState((s) => ({ ...s, phase: "error" }));
    ws.onclose = () => {
      setState((s) =>
        s.phase === "in_room" ? { ...s, phase: "idle", roomInfo: null } : s
      );
    };
  }, [workerUrl, onOffer, onAnswer, onIceCandidate, onRoundStart, onRoundEnd]);

  const startMatchmaking = useCallback(() => {
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
    return () => { wsRef.current?.close(); };
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
