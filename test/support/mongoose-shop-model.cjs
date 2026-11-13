// Real Mongoose queries/serialization with a driver collection held in memory.
let sequence = 0;
module.exports.createMongooseShopFixture = function ({ mongoose, schema }) {
  const connection = mongoose.createConnection();
  const model = connection.model(`ShopPersistenceFixture${++sequence}`, schema);
  const rows = new Map();
  const clone = (value) => structuredClone(value);
  const matches = (row, filter) =>
    Object.entries(filter).every(([key, value]) =>
      key === '$or'
        ? value.some((branch) => matches(row, branch))
        : key === 'adjustments.adminUserId'
          ? (row.adjustments ?? []).some((entry) => entry.adminUserId === value)
          : key === 'purchases.adminUserId'
            ? row.purchases.some((purchase) => purchase.adminUserId === value)
            : row[key] === value,
    );
  const project = (row, options) => {
    if (!row) return null;
    const output = clone(row);
    if (options?.projection?._id === 0) delete output._id;
    return output;
  };
  model.collection.insertOne = async (document) => {
    if (rows.has(document._id))
      throw Object.assign(new Error('Duplicate wallet'), { code: 11000 });
    rows.set(document._id, clone(document));
    return { acknowledged: true, insertedId: document._id };
  };
  model.collection.replaceOne = async (filter, document) => {
    const row = rows.get(filter._id);
    if (!row || !matches(row, filter))
      return { matchedCount: 0, modifiedCount: 0 };
    rows.set(document._id, clone(document));
    return { matchedCount: 1, modifiedCount: 1 };
  };
  model.collection.findOne = async (filter, options) =>
    project(
      [...rows.values()].find((row) => matches(row, filter)),
      options,
    );
  model.collection.find = (filter, options) => ({
    toArray: async () =>
      [...rows.values()]
        .filter((row) => matches(row, filter))
        .map((row) => project(row, options)),
  });
  model.collection.createIndex = async () => 'fixture-shop-index';
  return { model, rows, dispose: () => connection.destroy() };
};
