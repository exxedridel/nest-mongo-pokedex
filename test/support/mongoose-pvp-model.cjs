// Real Mongoose casting/serialization and queries, with an in-memory driver
// collection. This tests the Mongo adapter without a database or credentials.
let sequence = 0;
module.exports.createMongoosePvpFixture = function ({ mongoose, schema }) {
  const name = `PvpPersistenceFixture${++sequence}`;
  // Isolate collection objects even when fixtures use the same collection name.
  const connection = mongoose.createConnection();
  const model = connection.model(name, schema);
  const rows = new Map();
  const clone = (value) => structuredClone(value);
  const matches = (row, filter) =>
    Object.entries(filter).every(([key, value]) => row[key] === value);
  const project = (row, options) => {
    if (!row) return null;
    const result = clone(row);
    if (options?.projection?._id === 0) delete result._id;
    return result;
  };
  const unique = (next) => {
    for (const row of rows.values()) {
      if (row._id === next._id) continue;
      if (
        row.creationKey === next.creationKey ||
        (next.lockHeld &&
          row.lockHeld &&
          (row.adminId === next.adminId ||
            row.lockedUserIds.some((id) => next.lockedUserIds.includes(id))))
      )
        throw Object.assign(new Error('Duplicate fixture reservation'), {
          code: 11000,
        });
    }
  };
  model.collection.insertOne = async (document) => {
    unique(document);
    rows.set(document._id, clone(document));
    return { acknowledged: true, insertedId: document._id };
  };
  model.collection.replaceOne = async (filter, document) => {
    const row = rows.get(filter._id);
    if (!row || !matches(row, filter))
      return { matchedCount: 0, modifiedCount: 0 };
    unique(document);
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
  model.collection.createIndex = async () => 'fixture-index';
  return { model, rows, dispose: () => connection.destroy() };
};
