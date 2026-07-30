/* SCAFFOLD — owned by the Vehicle agent. Replace with the real implementation. */
export class CarSystem {
  constructor(game) { this.game = game; this.cars = []; }
  async init() {}
  /** @returns {Promise<Car[]>} cars placed on the start grid; exactly one isPlayer. */
  async spawnField(/* track, raceConfig */) { this.cars = []; return this.cars; }
  despawnAll() { this.cars.length = 0; }
  listCars() { return []; }
  fixedUpdate() {}
  update() {}
  dispose() {}
}
export default CarSystem;
