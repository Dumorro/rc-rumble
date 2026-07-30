/**
 * Depth resolve: the depth attachment -> a linear view-distance buffer (metres).
 *
 * This exists for two reasons. First, correctness: our ping-pong colour targets
 * alternate, and one of them owns the depth attachment, so a later pass would
 * eventually sample the depth texture of the very framebuffer it is drawing into
 * — a GL feedback loop. Second, speed: AO + motion blur + DOF together take ~70
 * depth taps per pixel, and doing the perspective un-projection once here is
 * strictly cheaper than doing it in every tap.
 *
 * Sky / far-plane pixels resolve to exactly `uFar`, so consumers can test for
 * "background" with `z >= uFar * 0.999`.
 */

import { GLSL_DEPTH } from './Common.js';

export const DEPTH_RESOLVE_FRAG = /* glsl */ `
precision highp float;

uniform highp sampler2D tDepth;
uniform float uNear;
uniform float uFar;

varying vec2 vUv;

${GLSL_DEPTH}

void main() {
  float d = texture2D( tDepth, vUv ).x;
  float z = rcViewZ( d, uNear, uFar );
  gl_FragColor = vec4( min( z, uFar ), 0.0, 0.0, 1.0 );
}
`;

export default { DEPTH_RESOLVE_FRAG };
