import Actor from './Actor.js';

// Второй заглушечный part фикстуры — радар-проекция того же актёра,
// зеркало пары Tank/TankRadar танков (доказывает, что gameSets/
// entitiesOnCanvas умеют распределять одну сущность по нескольким
// полотнам произвольным числом part-классов).
export default class ActorRadar extends Actor {}
