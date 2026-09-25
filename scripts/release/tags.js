import * as ui from './ui.js';

// Релизный тег — это и есть запуск публикации: его пуш стартует release.yml
// (OIDC Trusted Publishing). Поэтому тег сверяется не только на «есть/нет»,
// а с HEAD и с origin: повторный `git push origin <тег>`, который уже лежит в
// origin, — no-op, GitHub не видит нового события, и упавший CI сам не
// перезапустится. А тег, оставшийся на коммите до фикса, опубликовал бы
// старый код — ровно так появилась дыра `@vimp-games/tanks@0.22.1`.

// Чистое решение по трём sha (null — тега нет). Покрыто tags.test.js.
//   create    — тега нет нигде: поставить и запушить;
//   push      — тег на HEAD только локально (прерванный прогон): запушить;
//   retrigger — тег на HEAD уже в origin: удалить в origin и запушить снова;
//   move      — тег (локально или в origin) стоит не на HEAD.
export function tagAction({ head, local, remote }) {
  if ((remote && remote !== head) || (local && local !== head)) {
    return 'move';
  }

  if (remote) {
    return 'retrigger';
  }

  return local ? 'push' : 'create';
}

// `git ls-remote` отдаёт для аннотированного тега две строки: сам объект
// тега и `^{}` с коммитом. Нужен коммит; у лёгкого тега строка одна.
export function parseLsRemote(stdout, name) {
  const refs = new Map(
    stdout
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(parts => parts.length === 2)
      .map(([sha, ref]) => [ref, sha]),
  );

  return (
    refs.get(`refs/tags/${name}^{}`) ?? refs.get(`refs/tags/${name}`) ?? null
  );
}

async function readTagState(shell, cwd, name) {
  const head = await shell.read('git', ['rev-parse', 'HEAD'], {
    cwd,
    allowFailure: true,
  });
  const local = await shell.read(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/tags/${name}^{commit}`],
    { cwd, allowFailure: true },
  );
  const remote = await shell.read(
    'git',
    ['ls-remote', '--tags', 'origin', `refs/tags/${name}`],
    { cwd, allowFailure: true },
  );

  if (remote.code !== 0) {
    // без ответа origin решать «пушить или перевыставлять» не по чему;
    // холостой прогон ничего не пушит, и сеть ему не обязательна
    if (!shell.dryRun) {
      throw new Error(`git ls-remote origin не ответил: ${remote.output.trim()}`);
    }

    ui.log('  · dry-run: origin не ответил, считаем, что тега там нет');
  }

  const sha = result => (result.code === 0 ? result.stdout.trim() || null : null);

  return {
    head: sha(head),
    local: sha(local),
    remote: remote.code === 0 ? parseLsRemote(remote.stdout, name) : null,
  };
}

const short = sha => (sha ? sha.slice(0, 8) : '—');

// Ставит тег на HEAD и пушит его так, чтобы release.yml действительно
// запустился. Удаление тега в origin спрашивается всегда, в том числе под
// --yes: это действие наружу, и на повторе оно уместно, только если прошлый
// запуск CI упал, а не всё ещё идёт.
export async function releaseTag(shell, cwd, name) {
  const state = await readTagState(shell, cwd, name);
  const action = tagAction(state);

  if (action === 'retrigger') {
    ui.log(`  · тег ${name} уже в origin на HEAD — повторный пуш CI не запустит`);

    const approved = await ui.confirm(
      `Перевыставить ${name} в origin (удалить и запушить), чтобы перезапустить ` +
        'release.yml? Сначала убедитесь, что прошлый запуск упал, а не ещё идёт',
      // «нет» по умолчанию: живой запуск Enter-ом не перебить
      false,
    );

    if (!approved) {
      throw new Error(`прервано: ${name} уже в origin, CI повторно не запустится`);
    }
  }

  if (action === 'move') {
    ui.error(
      `  тег ${name} стоит не на HEAD: локально ${short(state.local)}, ` +
        `в origin ${short(state.remote)}, HEAD ${short(state.head)}`,
    );

    const approved = await ui.confirm(
      `Перевыставить ${name} на HEAD? Опубликуется HEAD, а не коммит старого тега`,
      false,
    );

    if (!approved) {
      throw new Error(
        `прервано: ${name} стоит не на HEAD — перевыставьте тег или поднимите версию`,
      );
    }
  }

  // retrigger без локального тега (его ставили с другой машины или удалили):
  // без него пуш после удаления в origin упал бы, оставив origin без тега
  if (action === 'create' || (action === 'retrigger' && !state.local)) {
    await shell.write('git', ['tag', name], { cwd });
  }

  if (action === 'move') {
    await shell.write('git', ['tag', '--force', name], { cwd });
  }

  // удаление и новый пуш вместо `push --force`: создание ref — событие, на
  // которое release.yml гарантированно реагирует
  if (state.remote) {
    await shell.write('git', ['push', 'origin', `:refs/tags/${name}`], { cwd });
  }

  await shell.write('git', ['push', 'origin', name], { cwd });
}
