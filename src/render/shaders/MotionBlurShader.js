/**
 * Camera-reprojection motion blur + radial speed smear.
 *
 * Each pixel's world position is rebuilt from the linear depth buffer, projected
 * with the PREVIOUS frame's view-projection matrix, and the colour is blurred
 * along the resulting screen velocity. That covers everything the camera does
 * (yaw into a corner, the chase-cam whip, jump rotation) in one full-screen pass
 * with no velocity buffer.
 *
 * On top of that sits a radial component driven by `uRadial`, which the camera /
 * vehicle systems push from speed — the Re-Volt "everything streaks past you"
 * rush. Foreground pixels are protected by a depth-similarity weight so the car
 * body never smears the background over itself.
 */

import { GLSL_DEPTH, GLSL_NOISE } from './Common.js';

export const MOTION_BLUR_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;      // linear view distance in metres
uniform mat4  uCamWorld;       // camera.matrixWorld
uniform mat4  uPrevViewProj;
uniform vec2  uProjParams;     // 1/P00, 1/P11
uniform vec2  uResolution;
uniform float uFar;
uniform float uStrength;
uniform float uMaxVelocity;    // in uv units
uniform float uRadial;         // speed-driven radial smear
uniform float uJitter;

varying vec2 vUv;

${GLSL_DEPTH}
${GLSL_NOISE}

#define MB_SAMPLES 8

void main() {
  vec4 base = texture2D( tDiffuse, vUv );
  float z = texture2D( tDepth, vUv ).r;

  vec3 viewPos = rcViewPosFromZ( vUv, z, uProjParams );
  vec4 world = uCamWorld * vec4( viewPos, 1.0 );

  vec4 prevClip = uPrevViewProj * world;
  vec2 prevUv = ( prevClip.xy / max( prevClip.w, 1e-5 ) ) * 0.5 + 0.5;

  vec2 vel = ( vUv - prevUv ) * uStrength;

  // radial rush centred on the screen, nothing in the middle
  vec2 c = vUv - 0.5;
  float r = length( c );
  vel += normalize( c + 1e-6 ) * ( uRadial * r * r * 2.0 );

  float speed = length( vel );
  if ( speed < 0.0004 ) {
    gl_FragColor = base;
    return;
  }
  vel *= min( 1.0, uMaxVelocity / speed );

  float jitter = ( rcIGN( gl_FragCoord.xy ) - 0.5 ) * uJitter;

  vec3 col = base.rgb;
  float total = 1.0;

  for ( int i = 1; i < MB_SAMPLES; i++ ) {
    float t = ( float( i ) + jitter ) / float( MB_SAMPLES - 1 );
    vec2 uv = vUv - vel * t;
    if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) continue;

    float zz = texture2D( tDepth, uv ).r;

    // reject samples much closer to the camera than us (they belong to another
    // object and would bleed forward); keep samples further away
    float w = ( 1.0 - t * 0.35 ) * clamp( 1.0 - ( z - zz ) / max( z * 0.5, 0.05 ), 0.0, 1.0 );

    col += texture2D( tDiffuse, uv ).rgb * w;
    total += w;
  }

  gl_FragColor = vec4( col / total, base.a );
}
`;

export default { MOTION_BLUR_FRAG };
