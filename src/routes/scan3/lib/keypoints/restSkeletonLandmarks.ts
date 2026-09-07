/**
 * Stage 7 of docs/thumbs/representing-keyboard-build-inputs.md: full-hand context -- the 21
 * MediaPipe-numbered landmark positions (wrist + 4 per finger, `$lib/hand.ts`'s `CONNECTIONS` layout)
 * for a given skeleton held at a fixed pose (all-zero/straight by default, or `neutralPose.ts`'s
 * fitted-meanDeg pose -- see `poseAngleFn` below).
 *
 * Deliberately NOT `ikSolve.ts`'s own `poseToLandmarkVectors`/`buildRestExtensionSkeleton`
 * (multi-view's "model rest" tile): those are tuned for a mirrored-video overlay (their own doc
 * comments: "the video feed is mirrored... 'matches the video' is the spec, not plain anatomy") and
 * `poseToLandmarkVectors` hardcodes an identity landmark-0 position -- neither matches this project's
 * `PLACEHOLDER_LANDMARK0_POSITION` or the `buildDefaultSkeleton` splay the capability clouds are
 * already built from. Reusing them here would render a skeleton visibly misaligned with the clouds
 * sitting next to it. This function instead reuses whatever `skeleton`/`position` the caller already
 * built its clouds from, guaranteeing the two agree.
 */
import { CONNECTIONS, type Finger, FINGERS, type Joints, SolvedHand } from '$lib/hand'
import { Matrix4, type Vector3Tuple } from 'three'

/**
 * Returns 21 landmark positions (mm, index 0 = wrist, matching MediaPipe's own numbering) for
 * `skeleton`, placed via `position`, posed via `poseAngleFn(finger, jointIndex) => [angleZ, angleY]`
 * (radians) -- defaults to all-zero (every joint straight) when omitted.
 */
export function restSkeletonLandmarks(
  skeleton: Joints,
  position: Matrix4,
  poseAngleFn: (finger: Finger, jointIndex: number) => [number, number] = () => [0, 0],
): Vector3Tuple[] {
  const solved = new SolvedHand(skeleton, position)
  const landmarks: Vector3Tuple[] = new Array(21)

  for (const finger of FINGERS) {
    solved.fkBy(finger, (jointIndex) => poseAngleFn(finger, jointIndex))
    // scale=1: see `sampleMcpSweep.ts`'s doc comment -- `buildDefaultSkeleton` bakes joint lengths as
    // already-absolute millimeters.
    const positions = solved.worldPositions(finger, 1)
    const indices = [0, ...CONNECTIONS[finger].map(([, to]) => to)]
    indices.forEach((landmark, i) => {
      landmarks[landmark] = positions[i].toArray() as Vector3Tuple
    })
  }

  return landmarks
}

/** One line segment per bone, as `[fromLandmark, toLandmark]` pairs -- reads directly off
 * `CONNECTIONS`, one array per finger, for a caller that wants to draw each finger's chain as its own
 * polyline (e.g. via `@threlte/extras`'s `MeshLineGeometry`). */
export function restSkeletonBoneChains(landmarks: Vector3Tuple[]): Record<string, Vector3Tuple[]> {
  const chains: Record<string, Vector3Tuple[]> = {}
  for (const finger of FINGERS) {
    const indices = [0, ...CONNECTIONS[finger].map(([, to]) => to)]
    chains[finger] = indices.map((i) => landmarks[i])
  }
  return chains
}
