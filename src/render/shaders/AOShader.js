/**
 * Depth-only ambient occlusion ("GTAO-lite").
 *
 * We deliberately do NOT run a second geometry pass for normals: at 1:10 RC
 * scale the frame is full of small props and 8 cars, so a normal prepass would
 * blow the 8 ms render budget. Instead normals are reconstructed from the linear
 * depth buffer using the best-of-4 neighbour trick (correct at silhouettes), and
 * occlusion is gathered with a per-pixel rotated spiral of hemisphere samples at
 * half resolution.
 *
 * Pass 1  AO_FRAG       -> half-res occlusion
 * Pass 2  AO_APPLY_FRAG -> depth-aware bilateral upsample, multiplied into colour
 */

import { GLSL_DEPTH, GLSL_NOISE } from './Common.js';

export const AO_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDepth;      // linear view distance in metres
uniform vec2  uResolution;     // half-res target size
uniform vec2  uProjParams;     // 1/P00, 1/P11
uniform float uProj11;
uniform float uFar;
uniform float uRadius;         // world-space radius in metres
uniform float uMaxScreenRadius;
uniform float uBias;
uniform float uPower;
uniform float uFrame;

varying vec2 vUv;

${GLSL_DEPTH}
${GLSL_NOISE}

#define AO_SAMPLES 10

vec3 viewFromUv( vec2 uv ) {
  float z = texture2D( tDepth, uv ).r;
  return rcViewPosFromZ( uv, z, uProjParams );
}

void main() {
  float z = texture2D( tDepth, vUv ).r;

  // sky / far plane: fully unoccluded
  if ( z >= uFar * 0.999 ) {
    gl_FragColor = vec4( 1.0 );
    return;
  }

  vec3 P = rcViewPosFromZ( vUv, z, uProjParams );
  vec2 texel = 1.0 / uResolution;

  // reconstruct the normal, picking the closer neighbour on each axis so
  // silhouettes do not bleed a fake normal across the edge
  vec3 pL = viewFromUv( vUv - vec2( texel.x, 0.0 ) );
  vec3 pR = viewFromUv( vUv + vec2( texel.x, 0.0 ) );
  vec3 pD = viewFromUv( vUv - vec2( 0.0, texel.y ) );
  vec3 pU = viewFromUv( vUv + vec2( 0.0, texel.y ) );

  vec3 dx = ( abs( pR.z - P.z ) < abs( P.z - pL.z ) ) ? ( pR - P ) : ( P - pL );
  vec3 dy = ( abs( pU.z - P.z ) < abs( P.z - pD.z ) ) ? ( pU - P ) : ( P - pD );
  vec3 N = normalize( cross( dx, dy ) );
  if ( N.z < 0.0 ) N = -N;

  // screen-space radius of the world-space sphere, clamped so close-ups stay cheap
  float screenRadius = min( uRadius * ( uProj11 * 0.5 ) / max( z, 0.001 ), uMaxScreenRadius );

  float rot = rcIGN( gl_FragCoord.xy + uFrame ) * 6.2831853;
  float ca = cos( rot ), sa = sin( rot );

  float occlusion = 0.0;
  float totalW = 0.0;

  for ( int i = 0; i < AO_SAMPLES; i++ ) {
    float fi = float( i ) + 0.5;
    float ang = fi * 2.3999632297;                            // golden-angle spiral
    float rad = sqrt( fi / float( AO_SAMPLES ) ) * screenRadius;

    vec2 dir = vec2( cos( ang ), sin( ang ) );
    dir = vec2( dir.x * ca - dir.y * sa, dir.x * sa + dir.y * ca );

    vec2 suv = vUv + dir * rad;
    if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) continue;

    vec3 S = viewFromUv( suv );
    vec3 v = S - P;
    float len = length( v );
    if ( len < 1e-5 ) continue;

    float cosH = dot( N, v / len );
    float rangeCheck = clamp( uRadius / max( len, 1e-4 ), 0.0, 1.0 );
    rangeCheck *= rangeCheck;

    occlusion += max( cosH - uBias, 0.0 ) * rangeCheck;
    totalW += 1.0;
  }

  float ao = 1.0 - occlusion / max( totalW, 1.0 );
  ao = pow( clamp( ao, 0.0, 1.0 ), uPower );

  gl_FragColor = vec4( ao, ao, ao, 1.0 );
}
`;

export const AO_APPLY_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform vec2  uAoTexel;      // 1 / half-res size
uniform float uIntensity;
uniform vec3  uColor;        // occlusion tint — slightly cool reads better than black
uniform float uFar;

varying vec2 vUv;

void main() {
  vec4 base = texture2D( tDiffuse, vUv );
  float z = texture2D( tDepth, vUv ).r;

  if ( z >= uFar * 0.999 || uIntensity <= 0.0 ) {
    gl_FragColor = base;
    return;
  }

  // 4-tap depth-aware upsample of the half-res AO buffer
  float sum = 0.0;
  float wsum = 0.0;
  for ( int y = 0; y < 2; y++ ) {
    for ( int x = 0; x < 2; x++ ) {
      vec2 o = ( vec2( float( x ), float( y ) ) - 0.5 ) * uAoTexel;
      float a = texture2D( tAO, vUv + o ).r;
      float zz = texture2D( tDepth, vUv + o ).r;
      float w = exp( -abs( zz - z ) * 12.0 );
      sum += a * w;
      wsum += w;
    }
  }
  float ao = wsum > 0.0001 ? sum / wsum : 1.0;
  ao = mix( 1.0, ao, uIntensity );

  gl_FragColor = vec4( base.rgb * mix( uColor, vec3( 1.0 ), ao ), base.a );
}
`;

export default { AO_FRAG, AO_APPLY_FRAG };
