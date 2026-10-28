Person segmentation used by occlusion.js (as in ar-test). Served from this folder so it works
without Google servers.

vision_bundle.js + wasm/   MediaPipe Tasks Vision (@mediapipe/tasks-vision 1.0.1, npm),
                           Apache License 2.0, https://github.com/google-ai-edge/mediapipe
selfie_segmenter.tflite    MediaPipe selfie segmentation model (general, 256x256) from
                           @mediapipe/selfie_segmentation, Apache License 2.0, with TFLite
                           metadata added so MediaPipe Tasks can run it.
