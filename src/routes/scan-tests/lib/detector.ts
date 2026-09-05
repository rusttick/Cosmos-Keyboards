// https://github.com/google/mediapipe/blob/master/docs/solutions/hands.md
// https://github.com/tensorflow/tfjs-models/blob/master/hand-pose-detection/src/mediapipe/detector.ts
import resLandmarks from '@mediapipe/hands/hand_landmark_full.tflite?url'
import resBinarypbh from '@mediapipe/hands/hands.binarypb?url'
import resPackedAssets from '@mediapipe/hands/hands_solution_packed_assets.data?url'
import resAssetsLoader from '@mediapipe/hands/hands_solution_packed_assets_loader?url'
import resSimdWasm from '@mediapipe/hands/hands_solution_simd_wasm_bin.wasm?url'
import resSimdWasmJs from '@mediapipe/hands/hands_solution_simd_wasm_bin?url'

import { type Hand, makeHand } from '$lib/hand'
import * as mp from '@mediapipe/hands'
import type { InputImage } from '@mediapipe/hands'
import { LandmarkFilter, type LandmarkFilterOptions } from './landmarkFilter'
import type { Handedness } from './orientation'

interface EstimationConfig {
  flipHorizontal?: boolean
}

/** Mediapipe detector adapted from the mediapipe source code.
 * I needed to make my own so I could set custom paths for each required file.
 * Much of the code remains unchanged.
 *
 * Ported from src/routes/scan/lib/detector.ts and retargeted onto $lib/hand
 * (the canonical FK/IK engine — see docs/thumbs/scan3.md, "Foundation"), so
 * scan-tests analysis runs against the same makeHand() the real product
 * (/scan3) will build from, not /scan's older fork.
 *
 * Scanning procedure is scoped to one hand per session: `maxNumHands` is fixed at 1, and the caller
 * declares which physical hand is being scanned up front instead of trusting MediaPipe's own per-frame
 * Left/Right classification. That classification is a separate, imperfect per-frame prediction from
 * landmark tracking (see docs/thumbs/test_results.md, 2026-09-02/09-03) that was previously read via
 * `hands[handedness]`, which could go briefly empty when a frame got misclassified. With only ever one
 * hand in frame and the handedness known in advance, there's nothing left to classify per frame — the
 * single detected hand (whatever label MediaPipe assigns it internally) is always treated as the
 * declared hand. Each scanning-procedure step is responsible for its own bad-data detection (occlusion,
 * low confidence, implausible motion) rather than this detector guessing whether tracking is trustworthy.
 */
class MediaPipeHandsMediaPipeDetector {
  private readonly handsSolution: mp.Hands
  private readonly handedness: Handedness
  // Filters the raw landmark output once, upstream of makeHand(), so every consumer (overlay, bone
  // vectors, angles, orientation) sees the same despiked/smoothed signal instead of each capture page
  // inventing its own page-local smoother over a derived value. Two independent filters: `keypoints`
  // (2D image-normalized) and `keypoints3D` (world landmarks) are different landmark sets entirely.
  // Same options passed to both -- a capture page experimenting with these (see flexion-sweep) is
  // tuning one filtering behavior, not two independently.
  private readonly keypointsFilter: LandmarkFilter
  private readonly keypoints3DFilter: LandmarkFilter

  private hands: { Left?: Hand; Right?: Hand } = {}
  private selfieMode = false

  constructor(handedness: Handedness, filterOptions?: LandmarkFilterOptions) {
    this.handedness = handedness
    this.keypointsFilter = new LandmarkFilter(filterOptions)
    this.keypoints3DFilter = new LandmarkFilter(filterOptions)
    this.handsSolution = new mp.Hands({
      locateFile(path: string) {
        switch (path) {
          case 'hand_landmark_full.tflite':
            return resLandmarks
          case 'hands.binarypb':
            return resBinarypbh
          case 'hands_solution_packed_assets_loader.js':
            return resAssetsLoader
          case 'hands_solution_packed_assets.data':
            return resPackedAssets
          case 'hands_solution_simd_wasm_bin.js':
            return resSimdWasmJs
          case 'hands_solution_simd_wasm_bin.wasm':
            return resSimdWasm
          default:
            throw new Error('Unknown path ' + path)
        }
      },
    })
    this.handsSolution.setOptions({
      modelComplexity: 1, // Full model
      selfieMode: this.selfieMode,
      maxNumHands: 1,
    })
    this.handsSolution.onResults((results) => {
      this.hands = {}
      if (results.multiHandLandmarks !== null && results.multiHandLandmarks.length > 0) {
        const t = performance.now() / 1000
        this.hands[this.handedness] = makeHand({
          keypoints: this.keypointsFilter.filter(results.multiHandLandmarks[0], t),
          keypoints3D: this.keypoints3DFilter.filter(results.multiHandWorldLandmarks[0], t),
          score: results.multiHandedness[0].score,
          handedness: this.handedness,
        })
      }
    })
  }

  /**
   * Estimates hand poses for an image or video frame.
   *
   * It returns a single hand or multiple hands based on the maxHands
   * parameter passed to the constructor of the class.
   *
   * @param input
   * ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement The input
   * image to feed through the network.
   *
   * @param config Optional.
   *       flipHorizontal: Optional. Default to false. When image data comes
   *       from camera, the result has to flip horizontally.
   *
   * @return An array of `Hand`s.
   */
  async estimateHands(input: InputImage, estimationConfig?: EstimationConfig) {
    if (
      estimationConfig
      && estimationConfig.flipHorizontal
      && estimationConfig.flipHorizontal !== this.selfieMode
    ) {
      this.selfieMode = estimationConfig.flipHorizontal
      this.handsSolution.setOptions({
        selfieMode: this.selfieMode,
      })
    }
    await this.handsSolution.send({ image: input as InputImage })
    return this.hands
  }

  dispose() {
    this.handsSolution.close()
  }

  reset() {
    this.handsSolution.reset()
    this.hands = {}
    this.selfieMode = false
    // MediaPipe's own tracker is restarting cold here, so filtering against pre-reset history would
    // fight a gap rather than take the resumed signal at face value -- same reasoning as the
    // gap-reset behavior inside LandmarkFilter itself.
    this.keypointsFilter.reset()
    this.keypoints3DFilter.reset()
  }

  initialize(): Promise<void> {
    return this.handsSolution.initialize()
  }
}

export type Detector = MediaPipeHandsMediaPipeDetector

export default async function(handedness: Handedness, filterOptions?: LandmarkFilterOptions) {
  const detector = new MediaPipeHandsMediaPipeDetector(handedness, filterOptions)
  await detector.initialize()
  return detector
}
