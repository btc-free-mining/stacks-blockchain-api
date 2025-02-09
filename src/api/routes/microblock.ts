import * as express from 'express';
import { addAsync, RouterWithAsync } from '@awaitjs/express';
import {
  Microblock,
  MicroblockListResponse,
  UnanchoredTransactionListResponse,
} from '@stacks/stacks-blockchain-api-types';

import { DataStore } from '../../datastore/common';
import {
  getMicroblockFromDataStore,
  getMicroblocksFromDataStore,
  getUnanchoredTxsFromDataStore,
} from '../controllers/db-controller';
import { has0xPrefix } from '../../helpers';
import { parseLimitQuery, parsePagingQueryInput } from '../pagination';

const MAX_MICROBLOCKS_PER_REQUEST = 200;

const parseMicroblockQueryLimit = parseLimitQuery({
  maxItems: MAX_MICROBLOCKS_PER_REQUEST,
  errorMsg: '`limit` must be equal to or less than ' + MAX_MICROBLOCKS_PER_REQUEST,
});

export function createMicroblockRouter(db: DataStore): RouterWithAsync {
  const router = addAsync(express.Router());

  router.getAsync('/', async (req, res) => {
    const limit = parseMicroblockQueryLimit(req.query.limit ?? 20);
    const offset = parsePagingQueryInput(req.query.offset ?? 0);
    const query = await getMicroblocksFromDataStore({ db, offset, limit });
    const response: MicroblockListResponse = {
      limit,
      offset,
      total: query.total,
      results: query.result,
    };

    // TODO: block schema validation
    res.json(response);
  });

  router.getAsync('/:hash', async (req, res) => {
    const { hash } = req.params;

    if (!has0xPrefix(hash)) {
      return res.redirect('/extended/v1/microblock/0x' + hash);
    }

    const block = await getMicroblockFromDataStore({ db, microblockHash: hash });
    if (!block.found) {
      res.status(404).json({ error: `cannot find microblock by hash ${hash}` });
      return;
    }
    const response: Microblock = block.result;
    // TODO: block schema validation
    res.json(response);
  });

  router.getAsync('/unanchored/txs', async (req, res) => {
    // TODO: implement pagination for /unanchored/txs
    const txs = await getUnanchoredTxsFromDataStore(db);
    const response: UnanchoredTransactionListResponse = {
      total: txs.length,
      results: txs,
    };
    res.json(response);
  });

  return router;
}
