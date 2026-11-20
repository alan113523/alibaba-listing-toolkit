import { fileURLToPath } from 'node:url';
import { loadPlan, readArgs, tools, writeSteps } from './plan.mjs';

const scope = loadPlan(fileURLToPath(new URL('./scope.example.json', import.meta.url)));

export default {
  async getSellerId(store) {
    return Object.hasOwn(scope.stores, store) ? scope.stores[store] : null;
  },

  async invoke({ store, sellerId, tool, args }) {
    const product = scope.products.find(row => row.store === store && row.id === args.productId);
    if (!product || scope.stores[store] !== sellerId) throw Error('SYNTHETIC_PRODUCT_REQUIRED');

    if (tool === tools.query && JSON.stringify(args) === JSON.stringify(readArgs(product))) {
      const { attributes, trade, sample } = product.changes;
      return { success: true, data: {
        productId: product.id,
        basicInfo: { attr: attributes },
        trade,
        sample: { supportSample: sample }
      } };
    }

    if (!writeSteps(product).some(([step, expected]) =>
      tools[step] === tool && JSON.stringify(expected) === JSON.stringify(args))) throw Error('UNKNOWN_SYNTHETIC_CALL');
    return { success: true, data: tool === tools.submit ? 'submit draft success' : 'draft edit success' };
  }
};
