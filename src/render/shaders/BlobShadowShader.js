/**
 * Contact / blob shadow.
 *
 * A shadow map at 1 cm per texel still misses the tiny dark wedge where a 33 mm
 * wheel meets the floor — and that wedge is most of what sells "this object is
 * really touching the ground". So every car also gets a cheap procedural blob:
 * a car-shaped (elongated, four-lobed) darkening disc rendered with multiply
 * blending, snapped to the contact plane.
 *
 * Instanced: one draw call for the whole field.
 */

export const BLOB_VERT = /* glsl */ `
attribute float aOpacity;
attribute float aSquash;

varying vec2  vLocal;
varying float vOpacity;
varying float vSquash;

void main() {
  vLocal = position.xy;
  vOpacity = aOpacity;
  vSquash = aSquash;

  vec4 local = vec4( position, 1.0 );
  #ifdef USE_INSTANCING
    local = instanceMatrix * local;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * local;
}
`;

export const BLOB_FRAG = /* glsl */ `
precision mediump float;

uniform vec3  uColor;
uniform float uHardness;

varying vec2  vLocal;
varying float vOpacity;
varying float vSquash;

void main() {
  // vLocal is a unit quad in [-1,1]; build a soft rounded-rect footprint with
  // four denser lobes where the wheels are.
  vec2 p = vLocal;

  float body = 1.0 - smoothstep( 0.35, 1.0, length( p * vec2( 1.0, 0.78 ) ) );

  vec2 w = abs( p ) - vec2( 0.58, 0.72 );
  float wheels = 1.0 - smoothstep( 0.0, 0.42, length( max( w, vec2( 0.0 ) ) ) + min( max( w.x, w.y ), 0.0 ) );

  float a = clamp( body * 0.85 + wheels * 0.55, 0.0, 1.0 );
  a = pow( a, uHardness );
  a *= vOpacity * vSquash;

  if ( a <= 0.002 ) discard;

  // multiply blending: rgb = 1 - a*(1-color)
  gl_FragColor = vec4( mix( vec3( 1.0 ), uColor, a ), 1.0 );
}
`;

export default { BLOB_VERT, BLOB_FRAG };
