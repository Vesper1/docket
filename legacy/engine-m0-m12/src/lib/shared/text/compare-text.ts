/**
 * Orders strings by their code units, never by a locale.
 *
 * Artifacts and reports are compared byte for byte across machines, so the
 * order two runs put their entries in cannot depend on where they ran.
 */
export const compareText = (left: string, right: string): number => {
	return left === right ? 0 : left < right ? -1 : 1;
};
