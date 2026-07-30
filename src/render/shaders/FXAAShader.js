/**
 * FXAA — luma-based edge anti-aliasing, run on the final sRGB image.
 *
 * This is the well-known Timothy Lottes formulation (edge detect from a 5-tap
 * luma cross, direction from the diagonal gradients, then a clamped 2-tap blur
 * along the edge) plus a subpixel-aliasing term. It is the right trade for this
 * game: MSAA would cost us the HDR pipeline, SMAA needs baked lookup textures
 * (banned — zero pre-made assets), and TAA would smear a 9 m/s toy car.
 */

export const FXAA_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 uTexel;        // 1 / resolution
uniform float uSubpix;      // 0..1 subpixel aliasing removal
uniform float uEdgeThreshold;
uniform float uEdgeThresholdMin;

varying vec2 vUv;

#define FXAA_SPAN_MAX 8.0
#define FXAA_REDUCE_MUL 0.125
#define FXAA_REDUCE_MIN 0.0078125

float luma( vec3 c ) { return dot( c, vec3( 0.299, 0.587, 0.114 ) ); }

void main() {
  vec2 t = uTexel;

  vec3 rgbM  = texture2D( tDiffuse, vUv ).rgb;
  vec3 rgbNW = texture2D( tDiffuse, vUv + vec2( -t.x, -t.y ) ).rgb;
  vec3 rgbNE = texture2D( tDiffuse, vUv + vec2(  t.x, -t.y ) ).rgb;
  vec3 rgbSW = texture2D( tDiffuse, vUv + vec2( -t.x,  t.y ) ).rgb;
  vec3 rgbSE = texture2D( tDiffuse, vUv + vec2(  t.x,  t.y ) ).rgb;

  float lM  = luma( rgbM );
  float lNW = luma( rgbNW );
  float lNE = luma( rgbNE );
  float lSW = luma( rgbSW );
  float lSE = luma( rgbSE );

  float lMin = min( lM, min( min( lNW, lNE ), min( lSW, lSE ) ) );
  float lMax = max( lM, max( max( lNW, lNE ), max( lSW, lSE ) ) );
  float range = lMax - lMin;

  // flat area — nothing to do
  if ( range < max( uEdgeThresholdMin, lMax * uEdgeThreshold ) ) {
    gl_FragColor = vec4( rgbM, 1.0 );
    return;
  }

  vec2 dir;
  dir.x = -( ( lNW + lNE ) - ( lSW + lSE ) );
  dir.y =  ( ( lNW + lSW ) - ( lNE + lSE ) );

  float dirReduce = max( ( lNW + lNE + lSW + lSE ) * 0.25 * FXAA_REDUCE_MUL, FXAA_REDUCE_MIN );
  float rcpDirMin = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + dirReduce );

  dir = clamp( dir * rcpDirMin, vec2( -FXAA_SPAN_MAX ), vec2( FXAA_SPAN_MAX ) ) * t;

  vec3 rgbA = 0.5 * (
    texture2D( tDiffuse, vUv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb +
    texture2D( tDiffuse, vUv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );

  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D( tDiffuse, vUv + dir * -0.5 ).rgb +
    texture2D( tDiffuse, vUv + dir *  0.5 ).rgb );

  float lB = luma( rgbB );
  vec3 result = ( lB < lMin || lB > lMax ) ? rgbA : rgbB;

  // subpixel term: blend toward the 3x3 average on very fine detail
  float lAvg = ( lNW + lNE + lSW + lSE + lM ) * 0.2;
  float subpix = clamp( abs( lAvg - lM ) / max( range, 1e-5 ), 0.0, 1.0 );
  subpix = subpix * subpix * uSubpix;
  result = mix( result, ( rgbNW + rgbNE + rgbSW + rgbSE + rgbM ) * 0.2, subpix );

  gl_FragColor = vec4( result, 1.0 );
}
`;

export default { FXAA_FRAG };
