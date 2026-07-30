/**
 * Bloom: threshold prefilter -> progressive downsample -> tent upsample.
 *
 * This is the "Next Generation Post Processing in Call of Duty" pyramid, which
 * gives a wide, energy-preserving, flicker-free glow at a fraction of the cost
 * of a big gaussian. Tuned for a bright toy world: a soft-knee threshold above
 * 1.0 so only genuinely hot pixels bloom — no washed-out haze over the whole
 * frame.
 */

import { FULLSCREEN_VERT, GLSL_COLOR } from './Common.js';

export const BLOOM_VERT = FULLSCREEN_VERT;

/**
 * Prefilter: quadratic soft-knee threshold + partial Karis average to stop a
 * single blown-out pixel from strobing across frames.
 */
export const BLOOM_PREFILTER_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2  uTexel;      // 1 / source resolution
uniform vec4  uFilter;     // x: threshold, y: threshold-knee, z: 2*knee, w: 0.25/knee
uniform float uClamp;      // hard ceiling to keep fireflies sane
varying vec2 vUv;

${GLSL_COLOR}

vec3 prefilter( vec3 c ) {
  c = min( c, vec3( uClamp ) );
  float br = max( c.r, max( c.g, c.b ) );
  float soft = br - uFilter.y;
  soft = clamp( soft, 0.0, uFilter.z );
  soft = soft * soft * uFilter.w;
  float contrib = max( soft, br - uFilter.x ) / max( br, 0.0001 );
  return c * contrib;
}

void main() {
  vec2 o = uTexel;
  vec3 a = texture2D( tDiffuse, vUv + vec2( -o.x, -o.y ) ).rgb;
  vec3 b = texture2D( tDiffuse, vUv + vec2(  o.x, -o.y ) ).rgb;
  vec3 c = texture2D( tDiffuse, vUv + vec2( -o.x,  o.y ) ).rgb;
  vec3 d = texture2D( tDiffuse, vUv + vec2(  o.x,  o.y ) ).rgb;

  // Karis weighting in the box average kills fireflies before they spread
  float wa = 1.0 / ( 1.0 + rcLuma( a ) );
  float wb = 1.0 / ( 1.0 + rcLuma( b ) );
  float wc = 1.0 / ( 1.0 + rcLuma( c ) );
  float wd = 1.0 / ( 1.0 + rcLuma( d ) );
  vec3 col = ( a * wa + b * wb + c * wc + d * wd ) / max( wa + wb + wc + wd, 0.0001 );

  gl_FragColor = vec4( prefilter( col ), 1.0 );
}
`;

/** 13-tap downsample (COD). Stable and wide for its cost. */
export const BLOOM_DOWN_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uTexel;   // 1 / source resolution
varying vec2 vUv;

void main() {
  vec2 o = uTexel;

  vec3 a = texture2D( tDiffuse, vUv + vec2( -2.0 * o.x,  2.0 * o.y ) ).rgb;
  vec3 b = texture2D( tDiffuse, vUv + vec2(  0.0,        2.0 * o.y ) ).rgb;
  vec3 c = texture2D( tDiffuse, vUv + vec2(  2.0 * o.x,  2.0 * o.y ) ).rgb;

  vec3 d = texture2D( tDiffuse, vUv + vec2( -2.0 * o.x,  0.0 ) ).rgb;
  vec3 e = texture2D( tDiffuse, vUv ).rgb;
  vec3 f = texture2D( tDiffuse, vUv + vec2(  2.0 * o.x,  0.0 ) ).rgb;

  vec3 g = texture2D( tDiffuse, vUv + vec2( -2.0 * o.x, -2.0 * o.y ) ).rgb;
  vec3 h = texture2D( tDiffuse, vUv + vec2(  0.0,       -2.0 * o.y ) ).rgb;
  vec3 i = texture2D( tDiffuse, vUv + vec2(  2.0 * o.x, -2.0 * o.y ) ).rgb;

  vec3 j = texture2D( tDiffuse, vUv + vec2( -o.x,  o.y ) ).rgb;
  vec3 k = texture2D( tDiffuse, vUv + vec2(  o.x,  o.y ) ).rgb;
  vec3 l = texture2D( tDiffuse, vUv + vec2( -o.x, -o.y ) ).rgb;
  vec3 m = texture2D( tDiffuse, vUv + vec2(  o.x, -o.y ) ).rgb;

  vec3 col = e * 0.125;
  col += ( a + c + g + i ) * 0.03125;
  col += ( b + d + f + h ) * 0.0625;
  col += ( j + k + l + m ) * 0.125;

  gl_FragColor = vec4( col, 1.0 );
}
`;

/** 9-tap tent upsample, additively blended onto the next mip up. */
export const BLOOM_UP_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2  uTexel;   // 1 / source resolution
uniform float uRadius;
varying vec2 vUv;

void main() {
  vec2 o = uTexel * uRadius;

  vec3 col = texture2D( tDiffuse, vUv + vec2( -o.x,  o.y ) ).rgb * 1.0;
  col += texture2D( tDiffuse, vUv + vec2(  0.0,  o.y ) ).rgb * 2.0;
  col += texture2D( tDiffuse, vUv + vec2(  o.x,  o.y ) ).rgb * 1.0;

  col += texture2D( tDiffuse, vUv + vec2( -o.x,  0.0 ) ).rgb * 2.0;
  col += texture2D( tDiffuse, vUv ).rgb * 4.0;
  col += texture2D( tDiffuse, vUv + vec2(  o.x,  0.0 ) ).rgb * 2.0;

  col += texture2D( tDiffuse, vUv + vec2( -o.x, -o.y ) ).rgb * 1.0;
  col += texture2D( tDiffuse, vUv + vec2(  0.0, -o.y ) ).rgb * 2.0;
  col += texture2D( tDiffuse, vUv + vec2(  o.x, -o.y ) ).rgb * 1.0;

  gl_FragColor = vec4( col * 0.0625, 1.0 );
}
`;

export default { BLOOM_VERT, BLOOM_PREFILTER_FRAG, BLOOM_DOWN_FRAG, BLOOM_UP_FRAG };
