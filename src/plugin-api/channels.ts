import type { JsonObject, PluginScope, Principal } from './contracts.js';

export interface ChannelOverview {
  readonly scope: PluginScope;
  readonly targets: readonly string[];
  readonly details: JsonObject;
}

/** Public channel identities associated with the caller's current target grants. */
export interface ChannelInfoReadAccess {
  listChannels(principal: Principal): readonly ChannelOverview[];
}
