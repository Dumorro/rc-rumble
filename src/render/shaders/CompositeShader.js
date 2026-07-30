/**
 * Final composite: the one pass that turns linear HDR into pixels.
 *
 *   lens distortion + chromatic aberration (sampling)
 *   + bloom
 *   + hit flash (pre-tonemap, so a big hit really blows out)
 *   x exposure  ->  ACES filmic  ->  sRGB encode
 *   -> procedural 3D LUT colour grade (per-track lift/gamma/gain/sat/contrast)
 *   -> slow-mo desaturation
 *   -> vignette
 *   -> film grain + ordered dither
 *
 * Everything is gated by #defines so an off feature costs literally nothing.
 */

import { GLSL_COLOR, GLSL_NOISE, GLSL_LUT } from './Common.js';

export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform sampler2D tLut;

uniform vec2  uResolution;
uniform float uAspect;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uLutSize;
uniform float uLutIntensity;

uniform float uCA;             // chromatic aberration in uv units at the edge
uniform float uDistortion;     // barrel (+) / pincushion (-)
uniform float uVignette;       // 0..1 amount
uniform float uVignetteSoft;
uniform float uGrain;
uniform float uTime;

uniform vec3  uFlashColor;
uniform float uFlashStrength;
uniform float uSlowMo;
uniform float uSaturation;
uniform float uFade;           // 0 = normal, 1 = black (screen fades)
uniform vec3  uFadeColor;

varying vec2 vUv;

${GLSL_COLOR}
${GLSL_NOISE}
${GLSL_LUT}

void main() {
  vec2 c = vUv - 0.5;
  c.x *= uAspect;
  float r2 = dot( c, c );
  vec2 dir = c / max( sqrt( r2 ), 1e-5 );

  vec2 uv = vUv;

  #ifdef USE_DISTORTION
    // subtle barrel warp that only shows up at speed
    vec2 warped = c * ( 1.0 + uDistortion * r2 );
    warped.x /= uAspect;
    uv = warped + 0.5;
  #endif

  vec3 col;

  #ifdef USE_CA
    float ca = uCA * ( 0.15 + r2 * 1.6 );
    vec2 o = dir * ca;
    o.x /= uAspect;
    col.r = texture2D( tDiffuse, uv + o ).r;
    col.g = texture2D( tDiffuse, uv ).g;
    col.b = texture2D( tDiffuse, uv - o ).b;
  #else
    col = texture2D( tDiffuse, uv ).rgb;
  #endif

  #ifdef USE_BLOOM
    col += texture2D( tBloom, uv ).rgb * uBloomStrength;
  #endif

  col += uFlashColor * uFlashStrength;

  col = rcACES( col, uExposure );
  col = rcLinearToSRGB( col );

  #ifdef USE_LUT
    vec3 graded = rcSampleLUT( tLut, col, uLutSize );
    col = mix( col, graded, uLutIntensity );
  #endif

  if ( uSaturation != 1.0 ) col = rcSaturation( col, uSaturation );
  if ( uSlowMo > 0.0 ) col = rcSaturation( col, 1.0 - 0.30 * uSlowMo ) * ( 1.0 - 0.06 * uSlowMo );

  #ifdef USE_VIGNETTE
    float v = 1.0 - uVignette * smoothstep( uVignetteSoft, 1.05, sqrt( r2 ) * 1.25 );
    col *= v;
  #endif

  #ifdef USE_GRAIN
    float n = rcHash12( gl_FragCoord.xy + fract( uTime ) * 512.0 ) - 0.5;
    // grain lives in the mids: shadows stay clean, highlights stay crisp
    float lum = rcLuma( col );
    float shape = 4.0 * lum * ( 1.0 - lum );
    col += n * uGrain * ( 0.35 + 0.65 * shape );
  #endif

  if ( uFade > 0.0 ) col = mix( col, uFadeColor, uFade );

  // 8-bit ordered dither kills banding in the sky gradient
  col += ( rcIGN( gl_FragCoord.xy ) - 0.5 ) * ( 1.0 / 255.0 );

  gl_FragColor = vec4( clamp( col, 0.0, 1.0 ), 1.0 );
}
`;

export default { COMPOSITE_FRAG };
