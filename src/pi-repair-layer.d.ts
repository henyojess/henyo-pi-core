declare module '#pi-repair-layer' {
  import type { ExtensionAPI as _ExtensionAPI } from '@earendil-works/pi-coding-agent';

  const toolRepair: (pi: _ExtensionAPI) => void;
  export default toolRepair;
}
