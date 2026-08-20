import { expect, test } from 'vitest';

import { PRODUCT_NAME } from './meta.ts';

test('the product is named docket', () => {
	expect(PRODUCT_NAME).toBe('docket');
});
