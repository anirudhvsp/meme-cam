/**
 * useFaceDetection
 * Loads face-api.js models, starts the camera, and runs detection on an interval.
 * Exposes similarity score computed against a target FaceRatios object.
 *
 * Mobile fixes:
 *  - Use a single consistent CDN + model source (@vladmandic/face-api everywhere)
 *  - Robust camera constraints that don't hard-fail on Android/iOS
 *  - Debounced detection loop (prevents inference queue build-up on slow CPUs)
 *  - autoPlay enforced via element.play() after srcObject is set (iOS requirement)
 *  - Canvas-based frame capture for consistent inference input on mobile
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

declare global {
  interface Window { faceapi: any; }
}

export type Point = { x: number; y: number };
export interface FaceRatios {
  mouthOpenness: number;
  mouthWidth: number;
  leftEyeOpenness: number;
  rightEyeOpenness: number;
  browRaise: number;
}

function dist(a: Point, b: Point) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

export function computeRatios(pts: Point[]): FaceRatios {
  const faceWidth  = dist(pts[0],  pts[16]);
  const faceHeight = dist(pts[19], pts[8]);
  const mouthH     = dist(pts[51], pts[57]);
  const mouthW     = dist(pts[48], pts[54]);
  const lEyeH      = dist(pts[37], pts[41]);
  const lEyeW      = dist(pts[36], pts[39]);
  const rEyeH      = dist(pts[44], pts[46]);
  const rEyeW      = dist(pts[42], pts[45]);
  const lBrowEye   = dist(pts[19], pts[37]);
  const rBrowEye   = dist(pts[24], pts[44]);

  return {
    mouthOpenness:    mouthH / (mouthW  || 1),
    mouthWidth:       mouthW / (faceWidth || 1),
    leftEyeOpenness:  lEyeH  / (lEyeW   || 1),
    rightEyeOpenness: rEyeH  / (rEyeW   || 1),
    browRaise:        ((lBrowEye + rBrowEye) / 2) / (faceHeight || 1),
  };
}

const FEATURE_CONFIG: { key: keyof FaceRatios; weight: number; sigma: number }[] = [
  { key: "mouthOpenness",    weight: 0.35, sigma: 0.06 },
  { key: "mouthWidth",       weight: 0.20, sigma: 0.04 },
  { key: "leftEyeOpenness",  weight: 0.18, sigma: 0.05 },
  { key: "rightEyeOpenness", weight: 0.18, sigma: 0.05 },
  { key: "browRaise",        weight: 0.09, sigma: 0.04 },
];

export function ratioSimilarity(a: FaceRatios, b: FaceRatios): number {
  let score = 0;
  for (const { key, weight, sigma } of FEATURE_CONFIG) {
    const diff = a[key] - b[key];
    score += Math.exp(-(diff * diff) / (2 * sigma * sigma)) * weight;
  }
  return Math.round(Math.pow(score, 1.5) * 100);
}

// Single consistent CDN for both the library and its models.
// face-api.js@0.22.2 and @vladmandic/face-api use different weight formats —
// mixing them causes silent failures, especially on mobile WebGL/WASM paths.
const FACEAPI_SCRIPT = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/dist/face-api.js";
const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model";

// Slower interval on mobile prevents inference jobs from queuing up behind each
// other, which manifests as the UI freezing or scores never updating.
function getDetectionInterval() {
  const isMobile = typeof navigator !== "undefined" &&
    /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  return isMobile ? 600 : 300;
}

interface UseFaceDetectionOptions {
  onScore?: (score: number) => void;
  targetRatios: FaceRatios | null;
  active: boolean;
}

export function useFaceDetection({ onScore, targetRatios, active }: UseFaceDetectionOptions) {
  const [modelsReady, setModelsReady] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [similarity, setSimilarity] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);

  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guard against overlapping async detections on slow devices
  const detectingRef = useRef(false);

  // ── Load face-api from a single consistent CDN ──────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Already loaded by a previous mount
    if (window.faceapi?.nets?.tinyFaceDetector) {
      setModelsReady(true);
      return;
    }

    const script = document.createElement("script");
    script.src = FACEAPI_SCRIPT;
    script.async = true;

    script.onload = async () => {
      try {
        await window.faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await window.faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);
        setModelsReady(true);
      } catch (e) {
        console.error("Model load failed", e);
        setLoadError(true);
      }
    };
    script.onerror = () => setLoadError(true);
    document.head.appendChild(script);

    return () => {
      if (document.head.contains(script)) document.head.removeChild(script);
    };
  }, []);

  // ── Start camera ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!modelsReady) return;

    // Try ideal constraints first; fall back to bare minimum so mobile browsers
    // that reject specific resolutions don't throw OverconstrainedError.
    const tryGetCamera = async () => {
      const constraints: MediaStreamConstraints[] = [
        { video: { width: { ideal: 480 }, height: { ideal: 360 }, facingMode: "user" }, audio: false },
        { video: { facingMode: "user" }, audio: false },
        { video: true, audio: false },
      ];

      for (const c of constraints) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(c);
          streamRef.current = stream;

          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            // iOS Safari requires an explicit .play() call after setting srcObject
            // and will only honour it when called from within a user-gesture context
            // or immediately after camera permission is granted.
            try { await videoRef.current.play(); } catch { /* autoplay policy — video will still render */ }
          }

          // Off-screen canvas for stable frame capture on mobile
          if (!canvasRef.current) {
            canvasRef.current = document.createElement("canvas");
            canvasRef.current.width  = 224;
            canvasRef.current.height = 168;
          }

          setCameraReady(true);
          return;
        } catch (err) {
          console.warn("Camera constraint attempt failed, retrying with simpler constraints", c, err);
        }
      }
      // All attempts failed
      setLoadError(true);
    };

    tryGetCamera();

    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [modelsReady]);

  // ── Detection loop ───────────────────────────────────────────────────────────
  const detect = useCallback(async () => {
    // Skip if a previous inference is still running (important on mobile)
    if (detectingRef.current) return;

    const video = videoRef.current;
    if (!video || video.readyState < 2 || !window.faceapi) return;

    detectingRef.current = true;
    try {
      // Draw current frame to the off-screen canvas and run detection on that.
      // This avoids issues with face-api reading a live video element directly
      // on mobile browsers (especially on iOS where WebGL textures may be stale).
      const canvas = canvasRef.current;
      let input: HTMLVideoElement | HTMLCanvasElement = video;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          input = canvas;
        }
      }

      const result = await window.faceapi
        .detectSingleFace(input, new window.faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
        .withFaceLandmarks(true);

      if (!result) {
        setFaceDetected(false);
        setSimilarity(null);
      } else {
        setFaceDetected(true);
        if (targetRatios && active) {
          const score = ratioSimilarity(computeRatios(result.landmarks.positions), targetRatios);
          setSimilarity(score);
          onScore?.(score);
        }
      }
    } finally {
      detectingRef.current = false;
    }
  }, [targetRatios, active, onScore]);

  useEffect(() => {
    if (!cameraReady) return;
    const interval = getDetectionInterval();
    intervalRef.current = setInterval(detect, interval);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [cameraReady, detect]);

  return { videoRef, modelsReady, cameraReady, faceDetected, similarity, loadError };
}
