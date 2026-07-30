/**
 * Shared GLSL building blocks for the RC RUMBLE post pipeline.
 *
 * Everything here is GLSL ES 1.00 (three.js default for ShaderMaterial) so the
 * passes compile without opting into GLSL3. Keep loops bounded by #define so the
 * compiler can unroll them.
 *
 * No textures, no data blobs — pure code.
 */

/** Full-screen triangle vertex shader (matches three's FullScreenQuad geometry). */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Colour space + tonemap helpers. ACES matches three's ACESFilmicToneMapping exactly. */
export const GLSL_COLOR = /* glsl */ `
float rcLuma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

vec3 rcRRTAndODTFit( vec3 v ) {
  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
  return a / b;
}

vec3 rcACES( vec3 color, float exposure ) {
  const mat3 ACESInputMat = mat3(
    vec3( 0.59719, 0.07600, 0.02840 ),
    vec3( 0.35458, 0.90834, 0.13383 ),
    vec3( 0.04823, 0.01566, 0.83777 )
  );
  const mat3 ACESOutputMat = mat3(
    vec3(  1.60475, -0.10208, -0.00327 ),
    vec3( -0.53108,  1.10813, -0.07276 ),
    vec3( -0.07367, -0.00605,  1.07602 )
  );
  color *= exposure / 0.6;
  color = ACESInputMat * color;
  color = rcRRTAndODTFit( color );
  color = ACESOutputMat * color;
  return clamp( color, 0.0, 1.0 );
}

vec3 rcLinearToSRGB( vec3 c ) {
  c = max( c, vec3( 0.0 ) );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 0.4166666667 ) ) - 0.055, step( vec3( 0.0031308 ), c ) );
}

vec3 rcSRGBToLinear( vec3 c ) {
  c = clamp( c, 0.0, 1.0 );
  return mix( c * 0.0773993808, pow( c * 0.9478672986 + 0.0521327014, vec3( 2.4 ) ), step( vec3( 0.04045 ), c ) );
}

vec3 rcSaturation( vec3 c, float s ) {
  return mix( vec3( rcLuma( c ) ), c, s );
}
`;

/**
 * Depth helpers.
 *
 * The post chain does NOT sample the depth attachment directly: a resolve pass
 * turns it into a linear view-distance buffer first. Two reasons —
 *  1. sampling a depth texture that is still attached to the framebuffer we are
 *     drawing into is a GL feedback loop (undefined + spammy), and our ping-pong
 *     targets alternate;
 *  2. every consumer wants linear distance anyway, so we pay the conversion once
 *     instead of ~70 times per pixel across AO + motion blur + DOF.
 *
 * `rcViewZ` is used by the resolve pass only. Everything downstream reads metres.
 */
export const GLSL_DEPTH = /* glsl */ `
/** Raw [0,1] window depth -> positive view-space distance in metres. */
float rcViewZ( float depth, float near, float far ) {
  float z = depth * 2.0 - 1.0;
  return ( 2.0 * near * far ) / ( far + near - z * ( far - near ) );
}

/**
 * View-space position from uv + linear distance.
 * projParams = vec2( 1/projectionMatrix[0][0], 1/projectionMatrix[1][1] ).
 * Result is right-handed with -Z forward, matching three's view space.
 */
vec3 rcViewPosFromZ( vec2 uv, float z, vec2 projParams ) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3( ndc * projParams * z, -z );
}
`;

/** Cheap hash noise — used for dithering, grain and sample rotation. */
export const GLSL_NOISE = /* glsl */ `
float rcHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

vec2 rcHash22( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}

/** Interleaved gradient noise — the classic temporally-stable dither. */
float rcIGN( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}
`;

/**
 * 3D LUT stored as a horizontal strip of `size` slices (size*size x size, RGBA8).
 * Trilinear: bilinear inside a slice for free, manual lerp across slices.
 */
export const GLSL_LUT = /* glsl */ `
vec3 rcSampleLUT( sampler2D lut, vec3 c, float size ) {
  c = clamp( c, 0.0, 1.0 );
  float sliceSize = 1.0 / size;
  float slicePx = sliceSize / size;
  float sliceInner = slicePx * ( size - 1.0 );

  float zf = c.b * ( size - 1.0 );
  float z0 = floor( zf );
  float z1 = min( z0 + 1.0, size - 1.0 );
  float zw = zf - z0;

  float xo = slicePx * 0.5 + c.r * sliceInner;
  float yo = ( 0.5 + c.g * ( size - 1.0 ) ) / size;

  vec3 s0 = texture2D( lut, vec2( xo + z0 * sliceSize, yo ) ).rgb;
  vec3 s1 = texture2D( lut, vec2( xo + z1 * sliceSize, yo ) ).rgb;
  return mix( s0, s1, zw );
}
`;

/** Simple copy shader used for blits and the emergency fallback path. */
export const COPY_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D( tDiffuse, vUv ) * uOpacity;
}
`;

export default {
  FULLSCREEN_VERT,
  GLSL_COLOR,
  GLSL_DEPTH,
  GLSL_NOISE,
  GLSL_LUT,
  COPY_FRAG,
};
