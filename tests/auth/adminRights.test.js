import isEnvAdmin from '../../packages/auth/src/lib/adminRights.js';

// Развилка источников админских прав. Смысл теста — зафиксировать приоритет:
// пока задан VIMP_ADMIN_IDENTITIES, ник не даёт прав вообще (это и есть
// закрытие дыры со свободным ником), а без него работает прежнее поведение
describe('isEnvAdmin', () => {
  it('без identities решает ник, регистр не важен', () => {
    const admin = { nicks: ['lgick'], identities: [] };

    expect(isEnvAdmin(admin, { nick: 'LGick' })).toBe(true);
    expect(isEnvAdmin(admin, { nick: 'Player1' })).toBe(false);
  });

  it('с непустым identities ник игнорируется полностью', () => {
    const admin = { nicks: ['lgick'], identities: ['github:123'] };

    expect(isEnvAdmin(admin, { nick: 'lgick', provider: 'github', providerUid: '999' })).toBe(
      false,
    );
  });

  it('совпадение provider:uid даёт права, чужой uid — нет', () => {
    const admin = { nicks: [], identities: ['github:123'] };

    expect(isEnvAdmin(admin, { nick: 'anyone', provider: 'GitHub', providerUid: '123' })).toBe(
      true,
    );
    expect(isEnvAdmin(admin, { nick: 'anyone', provider: 'github', providerUid: '124' })).toBe(
      false,
    );
  });

  it('без provider/providerUid при непустом identities отказывает (fail-closed)', () => {
    const admin = { nicks: ['lgick'], identities: ['github:123'] };

    expect(isEnvAdmin(admin, { nick: 'lgick' })).toBe(false);
    expect(isEnvAdmin(admin, { nick: 'lgick', provider: 'github', providerUid: null })).toBe(
      false,
    );
  });
});
