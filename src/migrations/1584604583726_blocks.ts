import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('blocks', {
    index_block_hash: {
      type: 'bytea',
      primaryKey: true,
    },
    block_hash: {
      type: 'bytea',
      notNull: true,
    },
    block_height: {
      type: 'integer',
      notNull: true,
    },
    burn_block_time: {
      type: 'integer',
      notNull: true,
    },
    burn_block_hash: {
      type: 'bytea',
      notNull: true,
    },
    burn_block_height: {
      type: 'integer',
      notNull: true,
    },
    miner_txid: {
      type: 'bytea',
      notNull: true,
    },
    parent_index_block_hash: {
      type: 'bytea',
      notNull: true,
    },
    parent_block_hash: {
      type: 'bytea',
      notNull: true,
    },
    parent_microblock_hash: {
      type: 'bytea',
      notNull: true,
    },
    parent_microblock_sequence: {
      type: 'integer',
      notNull: true,
    },
    canonical: {
      type: 'boolean',
      notNull: true,
    },
    execution_cost_read_count: {
      type: 'bigint',
      notNull: true,
    },
    execution_cost_read_length: {
      type: 'bigint',
      notNull: true,
    },
    execution_cost_runtime: {
      type: 'bigint',
      notNull: true,
    },
    execution_cost_write_count: {
      type: 'bigint',
      notNull: true,
    },
    execution_cost_write_length: {
      type: 'bigint',
      notNull: true,
    },
  });
  pgm.createIndex('blocks', 'block_height');
  pgm.createIndex('blocks', 'block_hash');
  pgm.createIndex('blocks', 'parent_index_block_hash');
  pgm.createIndex('blocks', 'parent_block_hash');
  pgm.createIndex('blocks', 'canonical');
}

/*
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('blocks');
}
*/
