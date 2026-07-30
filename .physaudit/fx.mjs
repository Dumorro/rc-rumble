import * as THREE from 'three';
import { Car } from '../src/vehicle/Car.js';
import { CAR_DEFS } from '../src/vehicle/CarDefs.js';
import { CollisionMeshBuilder } from '../src/physics/CollisionMesh.js';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.js';
import { EventBus } from '../src/core/EventBus.js';
const DT = 1/120;
function ground(){const b=new CollisionMeshBuilder();const p=[];
 for(let i=0;i<80;i++)for(let j=0;j<80;j++){const x0=-40+i,x1=x0+1,z0=-40+j,z1=z0+1;
  p.push(x0,0,z0,x0,0,z1,x1,0,z1);p.push(x0,0,z0,x1,0,z1,x1,0,z0);}
 b.addTriangles(p,null,1,null);return b.build();}
const MODS={grip:1,torque:1,steer:1,brake:1,maxSpeed:1,downforce:1,antiRoll:1};
function mk(mods, hazard){
  const game={bus:new EventBus(),scene:new THREE.Group(),physics:null,controlsLive:true};
  game.physics=new PhysicsWorld(game);
  game.physics.setTrack({collision:ground(),surfaces:null});
  if(hazard) game.pickups={ hazardSurfaceAt:(x,y,z)=> (z < hazard.z ? 15 : 0) };
  const d=CAR_DEFS.find(c=>c.id==='toyeca');
  const c=new Car(game,d,{id:0,isPlayer:true,position:new THREE.Vector3(0,d.comHeight+0.02,0)});
  game.physics.addBody(c.body); c.controlEnabled=true;
  if(mods) c.effectMods={...MODS,...mods};
  return {game,c};
}
function run(mods,steps,ctrl,hazard){
  const {game,c}=mk(mods,hazard);
  const step=()=>{game.physics.fixedUpdate(DT); c.fixedUpdate(DT);};
  for(let i=0;i<240;i++) step();
  c.applyControl(ctrl);
  for(let i=0;i<steps;i++) step();
  return c;
}
console.log('A · every effectMods channel now does something (240+900 steps, full throttle)');
const base=run(null,900,{throttle:1,steer:0});
console.log(`  neutral (no effectMods at all)   speed=${base.speed.toFixed(2)}  (guard: missing => all-1.0 works)`);
for(const [name,m] of [
  ['torque 1.85 (boost)',{torque:1.85}], ['torque 0.50 (frozen)',{torque:0.50}],
  ['grip 0.20 (frozen)',{grip:0.20}],    ['grip 0.32 (oiled)',{grip:0.32}],
  ['maxSpeed 0.70 (squash)',{maxSpeed:0.70}],
]) {
  const c=run(m,900,{throttle:1,steer:0});
  console.log(`  ${name.padEnd(24)} speed=${c.speed.toFixed(2)}  (${((c.speed/base.speed-1)*100).toFixed(0).padStart(4)}% vs neutral)`);
}
const bs=run(null,240,{throttle:0,brake:1,steer:0});
for(const [name,m] of [['brake 1.0',null],['brake 0.22 (frozen)',{brake:0.22}]]) {
  const {game,c}=mk(m,null); const step=()=>{game.physics.fixedUpdate(DT); c.fixedUpdate(DT);};
  for(let i=0;i<240;i++) step(); c.applyControl({throttle:1,steer:0});
  for(let i=0;i<700;i++) step(); const v0=c.speed;
  c.applyControl({throttle:0,brake:1,steer:0}); let n=0;
  while(c.speed>0.4 && n<1200){step();n++;}
  console.log(`  ${name.padEnd(24)} ${v0.toFixed(2)} -> 0 in ${(n*DT).toFixed(2)}s = ${(v0/(n*DT)).toFixed(1)} m/s^2`);
}
for(const [name,m] of [['steer 1.0',null],['steer 0.26 (frozen)',{steer:0.26}]]) {
  const c=run(m,600,{throttle:1,steer:1});
  console.log(`  ${name.padEnd(24)} yawRate=${c.yawRate.toFixed(3)} rad/s  steerAngle=${(c.wheels[0].steerAngle*57.3).toFixed(1)}deg`);
}
for(const [name,m] of [['antiRoll 1.0',null],['antiRoll 0.60 (frozen)',{antiRoll:0.60}]]) {
  const c=run(m,600,{throttle:1,steer:0.8});
  console.log(`  ${name.padEnd(24)} roll bias=${c.suspension.rollBias().toFixed(4)}  ARB moment F=${c.suspension.arbMomentFront.toFixed(4)}`);
}
for(const [name,m] of [['downforce 1.0',null],['downforce 1.30 (boost)',{downforce:1.30}]]) {
  const c=run(m,900,{throttle:1,steer:0});
  console.log(`  ${name.padEnd(24)} downforce=${c.aero.downforce.toFixed(3)} N  totalLoad=${c.suspension.totalLoad.toFixed(2)} N`);
}
console.log('\nB · oil slick actually makes the ground slippery (per wheel)');
{
  const {game,c}=mk(null,{z:-3});   // slick everywhere beyond z < -3
  const step=()=>{game.physics.fixedUpdate(DT); c.fixedUpdate(DT);};
  for(let i=0;i<240;i++) step();
  c.applyControl({throttle:1,steer:0});
  let reported=false;
  for(let i=0;i<1400;i++){ step();
    c.hazardSurfaceId = game.pickups.hazardSurfaceAt(c.body.position.x,c.body.position.y,c.body.position.z);
    if(c.body.position.z < -3 && !reported){
      console.log(`  entering slick at z=${c.body.position.z.toFixed(2)}: wheel surfaceIds=[${c.wheels.map(w=>w.surfaceId).join(',')}] grip=[${c.wheels.map(w=>w.surfaceGrip.toFixed(2)).join(',')}]`);
      reported=true; }
  }
  console.log(`  after 11s on oil: speed=${c.speed.toFixed(2)} m/s, wheel grip=[${c.wheels.map(w=>w.surfaceGrip.toFixed(2)).join(',')}] (wood would be 1.00)`);
}
{
  const {game,c}=mk(null,null);
  const step=()=>{game.physics.fixedUpdate(DT); c.fixedUpdate(DT);};
  for(let i=0;i<240;i++) step(); c.applyControl({throttle:1,steer:0});
  for(let i=0;i<1400;i++) step();
  console.log(`  same run on clean wood:  speed=${c.speed.toFixed(2)} m/s, grip=[${c.wheels.map(w=>w.surfaceGrip.toFixed(2)).join(',')}]`);
}
