const storeBase = (storeHash) => `https://api.bigcommerce.com/stores/${storeHash}`;

// Store
const storeUrl = (storeHash) => `${storeBase(storeHash)}/v2/store`;

// Webhooks
const webhooksUrl = (storeHash) => `${storeBase(storeHash)}/v2/hooks`;

// Products
const listProductsUrl = (storeHash, include = "") =>
  `${storeBase(storeHash)}/v3/catalog/products${include ? `?include=${include}` : ""}`;
const getProductUrl = (storeHash, productId) =>
  `${storeBase(storeHash)}/v3/catalog/products/${productId}`;
const batchUpdateProductsUrl = (storeHash) =>
  `${storeBase(storeHash)}/v3/catalog/products`;
const productChannelAssignmentsUrl = (storeHash) =>
  `${storeBase(storeHash)}/v3/catalog/products/channel-assignments`;

// Categories / trees
const listTreesUrl = (storeHash) => `${storeBase(storeHash)}/v3/catalog/trees`;
const listTreeCategoriesUrl = (storeHash) =>
  `${storeBase(storeHash)}/v3/catalog/trees/categories`;
const batchUpdateCategoriesUrl = (storeHash) =>
  `${storeBase(storeHash)}/v3/catalog/trees/categories`;

// Brands
const listBrandsUrl = (storeHash) => `${storeBase(storeHash)}/v3/catalog/brands`;
const updateBrandUrl = (storeHash, brandId) =>
  `${storeBase(storeHash)}/v3/catalog/brands/${brandId}`;

// Product images
const updateImageUrl = (storeHash, productId, imageId) =>
  `${storeBase(storeHash)}/v2/products/${productId}/images/${imageId}`;

// Channels
const listChannelsUrl = (storeHash) => `${storeBase(storeHash)}/v3/channels`;
const channelSiteUrl = (storeHash, channelId) =>
  `${storeBase(storeHash)}/v3/channels/${channelId}/site`;

module.exports = {
  storeUrl,
  webhooksUrl,
  listProductsUrl,
  getProductUrl,
  batchUpdateProductsUrl,
  productChannelAssignmentsUrl,
  listTreesUrl,
  listTreeCategoriesUrl,
  batchUpdateCategoriesUrl,
  listBrandsUrl,
  updateBrandUrl,
  updateImageUrl,
  listChannelsUrl,
  channelSiteUrl,
};
