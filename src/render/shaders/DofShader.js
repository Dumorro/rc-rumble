/**
 * Depth of field — cinematic moments only (intro flyby, finish cam, replay,
 * podium). It stays off during racing: at RC scale you want everything readable.
 *
 * Single-pass gather bokeh with a golden-angle spiral, circle-of-confusion from
 * the linear depth buffer, separate near/far falloff, and rim-biased sample
 * weighting so highlights read as a real lens iris rather than a gaussian smudge.
 */

import { GLSL_NOISE } from './Common.js';

export const DOF_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;      // linear view distance in metres
uniform vec2  uResolution;
uniform float uFocusDistance;  // metres
uniform float uFocusRange;     // metres fully in focus around the focal plane
uniform float uNearFalloff;    // metres to reach max blur in front
uniform float uFarFalloff;     // metres to reach max blur behind
uniform float uMaxBlur;        // in uv units
uniform float uBokehBias;      // 0 = gaussian-ish, 1 = ring-heavy bokeh
uniform float uIntensity;

varying vec2 vUv;

${GLSL_NOISE}

#define DOF_SAMPLES 22

float cocFor( float z ) {
  float d = z - uFocusDistance;
  float a = abs( d ) - uFocusRange;
  if ( a <= 0.0 ) return 0.0;
  float falloff = d < 0.0 ? uNearFalloff : uFarFalloff;
  return clamp( a / max( falloff, 0.001 ), 0.0, 1.0 );
}

void main() {
  vec4 base = texture2D( tDiffuse, vUv );

  if ( uIntensity <= 0.001 ) {
    gl_FragColor = base;
    return;
  }

  float z = texture2D( tDepth, vUv ).r;
  float coc = cocFor( z );

  float radius = coc * uMaxBlur * uIntensity;
  if ( radius < 0.0008 ) {
    gl_FragColor = base;
    return;
  }

  float aspect = uResolution.x / max( uResolution.y, 1.0 );
  float rot = rcIGN( gl_FragCoord.xy ) * 6.2831853;
  float ca = cos( rot ), sa = sin( rot );

  vec3 col = base.rgb;
  float total = 1.0;

  for ( int i = 0; i < DOF_SAMPLES; i++ ) {
    float fi = float( i ) + 0.5;
    float ang = fi * 2.3999632297;
    // push samples toward the rim of the disc for a real iris look
    float rr = mix( sqrt( fi / float( DOF_SAMPLES ) ), pow( fi / float( DOF_SAMPLES ), 0.28 ), uBokehBias );

    vec2 dir = vec2( cos( ang ), sin( ang ) );
    dir = vec2( dir.x * ca - dir.y * sa, dir.x * sa + dir.y * ca );
    vec2 off = dir * rr * radius;
    off.x /= aspect;

    vec2 uv = vUv + off;
    if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) continue;

    float sz = texture2D( tDepth, uv ).r;
    float scoc = cocFor( sz );

    // a sharp foreground pixel must not smear into the blurry background, but a
    // blurry foreground SHOULD bleed over a sharp background
    float w = ( sz < z ) ? scoc : 1.0;
    w *= 0.35 + 0.65 * scoc;

    vec3 s = texture2D( tDiffuse, uv ).rgb;
    // weight bright pixels a touch more so highlights form discs
    w *= 1.0 + 0.35 * clamp( max( s.r, max( s.g, s.b ) ) - 1.0, 0.0, 3.0 );

    col += s * w;
    total += w;
  }

  gl_FragColor = vec4( col / total, base.a );
}
`;

export default { DOF_FRAG };
