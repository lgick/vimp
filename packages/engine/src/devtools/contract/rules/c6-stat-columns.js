import { WARN, skip, verdict } from '../result.js';

// Движок пишет ровно пять имён (name, status, score, deaths, latency), и
// его CSS свёрстана под пять колонок. Другое число — не отказ: игра вправе
// привезти свои стили в ClientPlugin.styles. Поэтому warn, а не error.
export default {
  id: 'C6',
  name: 'statColumns',
  level: WARN,
  title: 'stat declares five columns (the engine CSS assumes five)',

  check(ctx) {
    const columns = ctx.clientConfig?.modules?.stat?.params?.columns;

    if (!columns) {
      return skip('no client stat columns');
    }

    if (columns.length === 5) {
      return verdict([]);
    }

    const note = ctx.clientPlugin?.styles
      ? 'the plugin ships its own styles'
      : undefined;

    return verdict(
      [
        `stat declares ${columns.length} column(s): the engine populates ` +
          'exactly name, status, score, deaths, latency and its CSS is laid ' +
          'out for five',
      ],
      note,
    );
  },
};
