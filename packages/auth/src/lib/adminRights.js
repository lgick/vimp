/**
 * Кто считается админом. VIMP_ADMIN_IDENTITIES (провайдер:uid) важнее
 * VIMP_ADMIN_NICKS: ник — строка, которую до первой регистрации может
 * занять кто угодно, а provider_uid принадлежит конкретному аккаунту
 * провайдера и не меняется при переименовании.
 *
 * @param {Object} admin - Блок config.admin ({nicks, identities}).
 * @param {Object} user - Кто входит.
 * @param {string} user.nick - Ник.
 * @param {string} [user.provider] - OAuth-провайдер строки users.
 * @param {string} [user.providerUid] - provider_uid строки users.
 * @returns {boolean} Давать ли роль admin.
 */
export default function isEnvAdmin(admin, { nick, provider, providerUid }) {
  const identities = admin?.identities ?? [];

  if (identities.length > 0) {
    if (!provider || providerUid === undefined || providerUid === null) {
      return false;
    }

    return identities.includes(
      `${String(provider).toLowerCase()}:${String(providerUid).toLowerCase()}`,
    );
  }

  return (admin?.nicks ?? []).includes(String(nick ?? '').toLowerCase());
}
