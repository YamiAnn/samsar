export function memoryRequestStore() {
  const records = new Map();
  return {
    records,
    async ensure(id, data) {
      if (!records.has(id)) records.set(id, { _id: id, ...structuredClone(data) });
      return structuredClone(records.get(id));
    },
    async get(id) { return structuredClone(records.get(id)); },
    async claim(id, leaseMs) {
      const record = records.get(id);
      if (!record || ['COMPLETED', 'FAILED'].includes(record.status) || Number(record.leaseUntil) > Date.now()) return null;
      Object.assign(record, { status: 'PROCESSING', leaseUntil: Date.now() + leaseMs });
      return structuredClone(record);
    },
    async save(id, fields) {
      if (records.get(id).status !== 'COMPLETED') Object.assign(records.get(id), structuredClone(fields));
      return structuredClone(records.get(id));
    },
  };
}

export function memoryCreditAccount(balance = 100) {
  const account = { _id: 'user', generationCredits: balance, generationCreditDebitReservations: {} };
  let debits = 0;
  const transactions = new Map();
  const Owner = {
    findById: () => ({ lean: async () => structuredClone(account) }),
    async findOneAndUpdate(filter, update) {
      const path = Object.keys(filter).find(key => key.startsWith('generationCreditDebitReservations.'));
      const key = path?.split('.')[1];
      if (key && account.generationCreditDebitReservations[key]) return null;
      if (update.$inc?.generationCredits) debits++;
      for (const [field, amount] of Object.entries(update.$inc || {})) account[field] = (account[field] || 0) + amount;
      for (const [field, value] of Object.entries(update.$set || {})) {
        if (field.startsWith('generationCreditDebitReservations.')) account.generationCreditDebitReservations[field.split('.')[1]] = value;
        else account[field] = value;
      }
      return structuredClone(account);
    },
    findOne: () => ({ lean: async () => structuredClone(account) }),
    async updateOne(_filter, update) { Object.assign(account, update.$set); },
  };
  const Ledger = { async updateOne(query, update) {
    if (!transactions.has(query.idempotencyKey)) transactions.set(query.idempotencyKey, update.$setOnInsert);
  } };
  return { Owner, Ledger, account, transactions, get debits() { return debits; } };
}
