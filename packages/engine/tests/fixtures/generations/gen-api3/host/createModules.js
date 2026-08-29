import ScriptedManager from './ScriptedManager.js';

// Фабрика игровых host-модулей фикстуры (HostPlugin.createModules).
export default function createModules(ctx) {
  return { scripted: new ScriptedManager(ctx) };
}
