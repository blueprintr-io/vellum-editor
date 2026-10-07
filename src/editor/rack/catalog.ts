import { RACK_DEVICE_SPECS, type RackCategory } from './devices';
import { rackDeviceSvg } from './face';

/** Original, self-contained equipment artwork; no network lookup needed.
 * In a rack, a unit holding one of these draws the device at the unit's own
 * size (see face.ts); `svg` is the default-size copy for library tiles and
 * loose icons, built on first use. Library ids are `rack-<device type>` and
 * are stored in recents and host catalogues - never rename one. */
export const RACK_EQUIPMENT: readonly {
  id: string;
  label: string;
  device: string;
  category: RackCategory;
  readonly svg: string;
}[] = RACK_DEVICE_SPECS.map((spec) => ({
  id: `rack-${spec.type}`,
  label: spec.label,
  device: spec.type,
  category: spec.category,
  get svg() {
    return rackDeviceSvg(spec.type, undefined, spec.span);
  },
}));

export const RACK_PRESETS = [12, 24, 42, 48].map((units) => ({
  id: `rack-${units}u`,
  label: `${units}U rack`,
  units,
}));
