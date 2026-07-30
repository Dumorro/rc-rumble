/**
 * Procedural sky — two modes in one program, selected by a #define.
 *
 *  OUTDOOR : Preetham analytic daylight model (turbidity / rayleigh / mie),
 *            with a limb-darkened sun disc, a horizon haze band and a ground
 *            bounce hemisphere so the IBL picks up floor colour.
 *  INDOOR  : soft studio / room gradient (floor -> wall -> ceiling) with a grid
 *            of rectangular ceiling light panels. Those panels are what give the
 *            toy cars their crisp moving specular streaks.
 *
 * Output is LINEAR HDR radiance (roughly 0..3 for sky, up to `uSunDiscClamp`
 * inside the sun disc), ready for ACES tonemapping and PMREM.
 */

export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vDir = world.xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position.z = gl_Position.w; // force to the far plane
}
`;

export const SKY_FRAG = /* glsl */ `
precision highp float;

varying vec3 vDir;

uniform vec3  uSunDirection;
uniform float uSunIntensity;
uniform vec3  uTint;
uniform float uExposure;

// ── outdoor ──────────────────────────────────────────────────────────────
uniform float uTurbidity;
uniform float uRayleigh;
uniform float uMieCoefficient;
uniform float uMieDirectionalG;
uniform float uSkyScale;
uniform float uSunDiscClamp;
uniform float uSunAngularDiameterCos;
uniform vec3  uGroundColor;
uniform float uGroundBounce;
uniform vec3  uHorizonColor;
uniform float uHorizonHaze;

// ── indoor ───────────────────────────────────────────────────────────────
uniform vec3  uCeilingColor;
uniform vec3  uWallColor;
uniform vec3  uFloorColor;
uniform vec3  uPanelColor;
uniform float uPanelIntensity;
uniform float uPanelSpacing;
uniform float uPanelSize;
uniform float uPanelSoftness;
uniform float uRoomHeight;
uniform float uCornerDarken;

const float PI = 3.141592653589793;
const float E  = 2.718281828459045;

// Preetham constants (Bruneton-normalised, same set three's Sky object uses)
const vec3  TOTAL_RAYLEIGH = vec3( 5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5 );
const vec3  MIE_CONST      = vec3( 1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14 );
const float RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const float MIE_ZENITH_LENGTH      = 1.25e3;
const float CUTOFF_ANGLE = 1.6110731556870734;
const float STEEPNESS    = 1.5;
const float EE           = 1000.0;

float sunIntensityFalloff( float zenithAngleCos ) {
  zenithAngleCos = clamp( zenithAngleCos, -1.0, 1.0 );
  return EE * max( 0.0, 1.0 - pow( E, -( ( CUTOFF_ANGLE - acos( zenithAngleCos ) ) / STEEPNESS ) ) );
}

vec3 totalMie( float T ) {
  float c = ( 0.2 * T ) * 1.0e-17;
  return 0.434 * c * MIE_CONST;
}

float rayleighPhase( float cosTheta ) {
  return ( 3.0 / ( 16.0 * PI ) ) * ( 1.0 + cosTheta * cosTheta );
}

float hgPhase( float cosTheta, float g ) {
  float g2 = g * g;
  float inv = 1.0 / pow( max( 1.0 - 2.0 * g * cosTheta + g2, 0.0001 ), 1.5 );
  return ( 1.0 / ( 4.0 * PI ) ) * ( ( 1.0 - g2 ) * inv );
}

vec3 outdoorSky( vec3 dir ) {
  vec3 up = vec3( 0.0, 1.0, 0.0 );
  vec3 sun = normalize( uSunDirection );

  float sunFade = 1.0 - clamp( 1.0 - exp( sun.y ), 0.0, 1.0 );
  float rayleighCoefficient = uRayleigh - ( 1.0 * ( 1.0 - sunFade ) );
  vec3 betaR = TOTAL_RAYLEIGH * rayleighCoefficient;
  vec3 betaM = totalMie( uTurbidity ) * uMieCoefficient;
  float sunE = sunIntensityFalloff( dot( sun, up ) );

  // optical depth along the view ray
  float zenithAngle = acos( max( 0.0, dot( up, dir ) ) );
  float denom = cos( zenithAngle ) + 0.15 * pow( max( 93.885 - ( ( zenithAngle * 180.0 ) / PI ), 0.001 ), -1.253 );
  float inverse = 1.0 / max( denom, 0.0001 );
  float sR = RAYLEIGH_ZENITH_LENGTH * inverse;
  float sM = MIE_ZENITH_LENGTH * inverse;

  vec3 Fex = exp( -( betaR * sR + betaM * sM ) );

  float cosTheta = dot( dir, sun );
  vec3 betaRTheta = betaR * rayleighPhase( cosTheta * 0.5 + 0.5 );
  vec3 betaMTheta = betaM * hgPhase( cosTheta, uMieDirectionalG );

  vec3 scatter = ( betaRTheta + betaMTheta ) / ( betaR + betaM );
  vec3 Lin = pow( sunE * scatter * ( 1.0 - Fex ), vec3( 1.5 ) );
  Lin *= mix(
    vec3( 1.0 ),
    pow( sunE * scatter * Fex, vec3( 0.5 ) ),
    clamp( pow( 1.0 - dot( up, sun ), 5.0 ), 0.0, 1.0 )
  );

  // faint night term so the sky never goes pure black at dusk
  vec3 L0 = vec3( 0.08 ) * Fex;

  // sun disc with a soft limb
  float disc = smoothstep( uSunAngularDiameterCos, uSunAngularDiameterCos + 0.00006, cosTheta );
  float limb = 1.0 - 0.35 * pow( clamp( ( 1.0 - cosTheta ) / max( 1.0 - uSunAngularDiameterCos, 1e-6 ), 0.0, 1.0 ), 2.0 );
  L0 += sunE * 19000.0 * Fex * disc * limb;

  // Raw Preetham radiance is in "sky luminance" units — the horizon term alone
  // lands around 100, which after ACES is a solid white wall. uSkyScale maps it
  // into our exposure range: ~1.2 at the horizon, ~0.8 blue at the zenith.
  vec3 col = Lin * uSkyScale;
  col += min( L0 * uSkyScale, vec3( uSunDiscClamp ) );
  col += vec3( 0.0, 0.0004, 0.0009 );

  // extra haze right at the horizon reads as depth on an oversized track
  float hz = 1.0 - clamp( abs( dir.y ) * 6.0, 0.0, 1.0 );
  float skyLum = max( col.r, max( col.g, col.b ) );
  col = mix( col, mix( col, uHorizonColor * skyLum * ( 0.55 + 0.45 * max( sun.y, 0.0 ) ), 0.6 ), hz * uHorizonHaze );

  // ground hemisphere: colour bounce for the IBL, and stops a black lower half.
  // Scaled by the sky luminance so it stays consistent at any time of day.
  if ( dir.y < 0.05 ) {
    float lum = max( col.r, max( col.g, col.b ) );
    vec3 ground = uGroundColor * uGroundBounce * lum * ( 0.4 + 0.6 * clamp( sun.y * 1.5, 0.0, 1.0 ) );
    float t = smoothstep( 0.05, -0.10, dir.y );
    col = mix( col, ground, t );
  }

  return col * uSunIntensity;
}

float softRect( vec2 p, vec2 halfSize, float soft ) {
  vec2 d = abs( p ) - halfSize;
  float outside = length( max( d, vec2( 0.0 ) ) );
  float inside = min( max( d.x, d.y ), 0.0 );
  return 1.0 - smoothstep( -soft, soft, outside + inside );
}

vec3 indoorSky( vec3 dir ) {
  float y = dir.y;

  // vertical gradient: floor -> wall -> ceiling
  vec3 col;
  if ( y >= 0.0 ) {
    float t = pow( clamp( y, 0.0, 1.0 ), 0.75 );
    col = mix( uWallColor, uCeilingColor, t );
  } else {
    float t = pow( clamp( -y, 0.0, 1.0 ), 0.65 );
    col = mix( uWallColor, uFloorColor, t );
  }

  // horizon band darkening (walls meeting the floor / corner occlusion)
  float band = 1.0 - uCornerDarken * ( 1.0 - smoothstep( 0.0, 0.35, abs( y ) ) );
  col *= band;

  // ceiling light panels projected onto a plane at uRoomHeight
  if ( y > 0.12 ) {
    float t = uRoomHeight / y;
    vec2 p = dir.xz * t;
    vec2 cell = mod( p + uPanelSpacing * 0.5, uPanelSpacing ) - uPanelSpacing * 0.5;
    float panel = softRect( cell, vec2( uPanelSize, uPanelSize * 2.2 ), uPanelSoftness );
    // fade panels out with distance so we do not get infinite tiling glare
    float fade = exp( -length( p ) * 0.045 );
    float rise = smoothstep( 0.12, 0.35, y );
    col += uPanelColor * ( uPanelIntensity * panel * fade * rise );
  }

  // a soft key from the sun direction keeps indoor reflections directional
  float key = pow( max( dot( dir, normalize( uSunDirection ) ), 0.0 ), 12.0 );
  col += uPanelColor * key * 0.25 * uPanelIntensity;

  return col * uSunIntensity;
}

void main() {
  vec3 dir = normalize( vDir );

  #ifdef SKY_INDOOR
    vec3 col = indoorSky( dir );
  #else
    vec3 col = outdoorSky( dir );
  #endif

  col *= uTint * uExposure;

  gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );

  // No-ops when we are rendering into an HDR target (three disables tone mapping
  // for render targets and the target is linear), correct when the emergency
  // no-post path draws straight to the screen.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export default { SKY_VERT, SKY_FRAG };
