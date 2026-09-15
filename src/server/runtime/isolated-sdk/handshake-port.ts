import type { IsolatedCapabilityHandshakePort } from "../prepare-run";
import { isHandshakeReady } from "../prepare-run";

export async function handshakeAllowsSpawn(port: IsolatedCapabilityHandshakePort): Promise<boolean> {
  const probed = await port.probe();
  return probed.ok && isHandshakeReady(probed.value);
}
