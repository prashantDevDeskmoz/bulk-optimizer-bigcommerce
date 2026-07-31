const Channel = require("../models/Channel");
const Template = require("../models/Template");

// Store name is inlined (not kept as a token) because the renderers resolve
// [[store name]] to an empty string — same behaviour as the template editor.
const defaultTemplates = (storeName) => [
  { applyTo: "products", target: "title", template: `[[product name]] | [[brand]]` },
  { applyTo: "products", target: "meta", template: `Buy [[product name]] from ${storeName} at the best price.` },
  { applyTo: "products", target: "alt", template: `[[product name]]-Image1` },
  { applyTo: "categories", target: "title", template: `[[category name]] | ${storeName}` },
  { applyTo: "categories", target: "meta", template: `Browse [[category name]] at ${storeName}. Discover quality products at great prices.` },
  { applyTo: "brands", target: "title", template: `[[name]] Products | ${storeName}` },
  { applyTo: "brands", target: "meta", template: `Browse the latest [[name]] collection at ${storeName} with great prices.` },
];

const populateDefaultTemplates = async (store) => {
  try {
    const channels = await Channel.find({ storeId: store._id }).select("bcChannelId").lean();
    if (channels.length === 0) return;

    const storeName = (store.store_name || store.store_domain || "").trim();
    const templates = defaultTemplates(storeName);

    const bulkOperations = [];
    for (const channel of channels) {
      for (const { applyTo, target, template } of templates) {
        bulkOperations.push({
          updateOne: {
            filter: {
              storeId: store._id,
              bcChannelId: String(channel.bcChannelId),
              applyTo,
              target,
            },
            // $set so a re-install never overwrites templates the merchant edited
            update: { $set: { template }, cruiseControl: false },
            upsert: true,
          },
        });
      }
    }

    await Template.bulkWrite(bulkOperations);
  } catch (error) {
    console.error("[populateDefaultTemplates]", error.message);
  }
};

module.exports = { populateDefaultTemplates };
