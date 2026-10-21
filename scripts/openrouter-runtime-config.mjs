export const DEFAULT_OPENROUTER_GEMINI_4_ARGON_MODEL = 'google/gemini-4-argon';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveOpenRouterRuntimeConfig({ providerConfig = {}, providerSecrets = {} } = {}) {
  const configuredApiKey = normalizeString(providerSecrets.apiKey) || normalizeString(providerConfig.apiKey);
  const enabled = providerConfig.enabled === true && Boolean(configuredApiKey);

  if (!enabled) {
    return {
      enabled: false,
      apiKey: '',
      gemini4ArgonModel: '',
    };
  }

  const gemini4ArgonModel = normalizeString(providerConfig.gemini4ArgonModel) ||
    DEFAULT_OPENROUTER_GEMINI_4_ARGON_MODEL;

  return {
    enabled: true,
    apiKey: configuredApiKey,
    gemini4ArgonModel,
  };
}

export function applyEffectiveOpenRouterProviderConfig(providers = {}, providerSecrets = {}) {
  const openrouter = resolveOpenRouterRuntimeConfig({
    providerConfig: providers.openrouter,
    providerSecrets,
  });

  return {
    providers: {
      ...providers,
      openrouter: {
        ...(providers.openrouter || {}),
        enabled: openrouter.enabled,
      },
    },
    openrouter,
  };
}
