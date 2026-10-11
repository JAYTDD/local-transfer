export function channelEndpointUrl(channelId: string): string {
  return `${window.location.origin}/v1/channels/${channelId}`;
}
