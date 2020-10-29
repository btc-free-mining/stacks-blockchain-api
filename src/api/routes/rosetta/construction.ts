import { addAsync, RouterWithAsync } from '@awaitjs/express';
import * as BN from 'bn.js';
import {
  NetworkIdentifier,
  RosettaConstructionDeriveResponse,
  RosettaConstructionHashRequest,
  RosettaConstructionHashResponse,
  RosettaConstructionMetadataResponse,
  RosettaConstructionPreprocessResponse,
  RosettaMaxFeeAmount,
  RosettaOperation,
  RosettaOptions,
  RosettaPublicKey,
  RosettaConstructionSubmitResponse,
  RosettaConstructionPreprocessRequest,
  RosettaConstructionMetadataRequest,
  RosettaConstructionPayloadResponse,
  RosettaConstructionCombineRequest,
  RosettaConstructionCombineResponse,
} from '@blockstack/stacks-blockchain-api-types';
import {
  createMessageSignature,
  createTransactionAuthField,
  emptyMessageSignature,
  isSingleSig,
  makeSigHashPreSign,
  MessageSignature,
} from '@blockstack/stacks-transactions/lib/authorization';
import { BufferReader } from '@blockstack/stacks-transactions/lib/bufferReader';
import {
  deserializeTransaction,
  StacksTransaction,
} from '@blockstack/stacks-transactions/lib/transaction';
import {
  UnsignedTokenTransferOptions,
  makeUnsignedSTXTokenTransfer,
  TokenTransferOptions,
  UnsignedMultiSigTokenTransferOptions,
  TransactionSigner,
  AuthType,
} from '@blockstack/stacks-transactions';
import * as express from 'express';
import { StacksCoreRpcClient } from '../../../core-rpc/client';
import { DataStore, DbBlock } from '../../../datastore/common';
import {
  FoundOrNot,
  hexToBuffer,
  isValidC32Address,
  digestSha512_256,
  has0xPrefix,
} from '../../../helpers';
import { RosettaConstants, RosettaErrors } from '../../rosetta-constants';
import {
  bitcoinAddressToSTXAddress,
  getOperations,
  getOptionsFromOperations,
  getSigners,
  isDecimalsSupported,
  isSignedTransaction,
  isSymbolSupported,
  publicKeyToBitcoinAddress,
  rawTxToBaseTx,
  rawTxToStacksTransaction,
  GetStacksTestnetNetwork,
  makePresignHash,
  verifySignature,
} from './../../../rosetta-helpers';
import { makeRosettaError, rosettaValidateRequest, ValidSchema } from './../../rosetta-validate';

export function createRosettaConstructionRouter(db: DataStore): RouterWithAsync {
  const router = addAsync(express.Router());
  router.use(express.json());

  //construction/derive endpoint
  router.postAsync('/derive', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body);
    if (!valid.valid) {
      //TODO have to fix this and make error generic
      if (valid.error?.includes('should be equal to one of the allowed values')) {
        res.status(400).json(RosettaErrors.invalidCurveType);
      }
      res.status(400).json(makeRosettaError(valid));
      return;
    }

    const publicKey: RosettaPublicKey = req.body.public_key;
    const network: NetworkIdentifier = req.body.network_identifier;

    if (has0xPrefix(publicKey.hex_bytes)) {
      publicKey.hex_bytes = publicKey.hex_bytes.replace('0x', '');
    }

    try {
      const btcAddress = publicKeyToBitcoinAddress(publicKey.hex_bytes, network.network);
      if (btcAddress === undefined) {
        res.status(400).json(RosettaErrors.invalidPublicKey);
        return;
      }
      const stxAddress = bitcoinAddressToSTXAddress(btcAddress);

      const response: RosettaConstructionDeriveResponse = {
        address: stxAddress,
      };
      res.json(response);
    } catch (e) {
      res.status(400).json(RosettaErrors.invalidPublicKey);
    }
  });

  //construction/preprocess endpoint
  router.postAsync('/preprocess', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body);
    if (!valid.valid) {
      res.status(400).json(makeRosettaError(valid));
      return;
    }

    const operations: RosettaOperation[] = req.body.operations;

    // We are only supporting transfer, we should have operations length = 3
    if (operations.length != 3) {
      res.status(400).json(RosettaErrors.invalidOperation);
      return;
    }

    if (!isSymbolSupported(req.body.operations)) {
      res.status(400).json(RosettaErrors.invalidCurrencySymbol);
      return;
    }

    if (!isDecimalsSupported(req.body.operations)) {
      res.status(400).json(RosettaErrors.invalidCurrencyDecimals);
      return;
    }

    const options = getOptionsFromOperations(req.body.operations);
    if (options == null) {
      res.status(400).json(RosettaErrors.invalidOperation);
      return;
    }

    if (req.body.metadata) {
      if (req.body.metadata.gas_limit) {
        options.gas_limit = req.body.metadata.gas_limit;
      }

      if (req.body.metadata.gas_price) {
        options.gas_price = req.body.metadata.gas_price;
      }

      if (req.body.suggested_fee_multiplier) {
        options.suggested_fee_multiplier = req.body.suggested_fee_multiplier;
      }
    }

    if (req.body.max_fee) {
      const max_fee: RosettaMaxFeeAmount = req.body.max_fee[0];
      if (
        max_fee.currency.symbol === RosettaConstants.symbol &&
        max_fee.currency.decimals === RosettaConstants.decimals
      ) {
        options.max_fee = max_fee.value;
      } else {
        res.status(400).json(RosettaErrors.invalidFee);
        return;
      }
    }

    const rosettaPreprocessResponse: RosettaConstructionPreprocessResponse = {
      options,
      required_public_keys: [
        {
          address: options.sender_address as string,
        },
      ],
    };
    res.json(rosettaPreprocessResponse);
  });

  //construction/metadata endpoint
  router.postAsync('/metadata', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body);
    if (!valid.valid) {
      res.status(400).json(makeRosettaError(valid));
      return;
    }

    const request: RosettaConstructionMetadataRequest = req.body;
    const options: RosettaOptions = req.body.options;
    if (options.type != 'token_transfer') {
      res.status(400).json(RosettaErrors.invalidTransactionType);
      return;
    }

    if (options?.sender_address && !isValidC32Address(options.sender_address)) {
      res.status(400).json(RosettaErrors.invalidSender);
      return;
    }
    if (options?.symbol !== RosettaConstants.symbol) {
      res.status(400).json(RosettaErrors.invalidCurrencySymbol);
      return;
    }

    const recipientAddress = options.token_transfer_recipient_address;
    if (options?.decimals !== RosettaConstants.decimals) {
      res.status(400).json(RosettaErrors.invalidCurrencyDecimals);
      return;
    }

    if (recipientAddress == null || !isValidC32Address(recipientAddress)) {
      res.status(400).json(RosettaErrors.invalidRecipient);
      return;
    }

    if (request.public_keys && request.public_keys.length > 0) {
      const publicKey: RosettaPublicKey = request.public_keys[0];

      if (has0xPrefix(publicKey.hex_bytes)) {
        publicKey.hex_bytes = publicKey.hex_bytes.replace('0x', '');
      }

      try {
        const btcAddress = publicKeyToBitcoinAddress(
          publicKey.hex_bytes,
          request.network_identifier.network
        );
        if (btcAddress === undefined) {
          res.status(400).json(RosettaErrors.invalidPublicKey);
          return;
        }
        const stxAddress = bitcoinAddressToSTXAddress(btcAddress);

        if (stxAddress !== options.sender_address) {
          res.status(400).json(RosettaErrors.invalidPublicKey);
          return;
        }
      } catch (e) {
        res.status(400).json(RosettaErrors.invalidPublicKey);
        return;
      }
    }

    const accountInfo = await new StacksCoreRpcClient().getAccount(recipientAddress);
    const nonce = accountInfo.nonce;

    let recentBlockHash = undefined;
    const blockQuery: FoundOrNot<DbBlock> = await db.getCurrentBlock();
    if (blockQuery.found) {
      recentBlockHash = blockQuery.result.block_hash;
    }

    const response: RosettaConstructionMetadataResponse = {
      metadata: {
        ...req.body.options,
        account_sequence: nonce,
        recent_block_hash: recentBlockHash,
      },
    };

    res.json(response);
  });

  //construction/hash endpoint
  router.postAsync('/hash', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body);
    if (!valid.valid) {
      res.status(400).json(makeRosettaError(valid));
      return;
    }

    const request: RosettaConstructionHashRequest = req.body;

    if (!has0xPrefix(request.signed_transaction)) {
      request.signed_transaction = '0x' + request.signed_transaction;
    }

    let buffer: Buffer;
    try {
      buffer = hexToBuffer(request.signed_transaction);
    } catch (error) {
      res.status(400).json(RosettaErrors.invalidTransactionString);
      return;
    }

    const transaction = deserializeTransaction(BufferReader.fromBuffer(buffer));
    const hash = transaction.txid();

    if (!transaction.auth.spendingCondition) {
      res.status(400).json(RosettaErrors.transactionNotSigned);
      return;
    }
    if (isSingleSig(transaction.auth.spendingCondition)) {
      /**Single signature Transaction has an empty signature, so the transaction is not signed */
      if (
        !transaction.auth.spendingCondition.signature.data ||
        emptyMessageSignature().data === transaction.auth.spendingCondition.signature.data
      ) {
        res.status(400).json(RosettaErrors.transactionNotSigned);
        return;
      }
    } else {
      /**Multi-signature transaction does not have signature fields thus the transaction not signed */
      if (transaction.auth.spendingCondition.fields.length === 0) {
        res.status(400).json(RosettaErrors.transactionNotSigned);
        return;
      }
    }

    const hashResponse: RosettaConstructionHashResponse = {
      transaction_identifier: {
        hash: '0x' + hash,
      },
    };
    res.status(200).json(hashResponse);
  });

  //construction/parse endpoint
  router.postAsync('/parse', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body);
    if (!valid.valid) {
      res.status(400).json(makeRosettaError(valid));
      return;
    }
    let inputTx = req.body.transaction;
    const signed = req.body.signed;

    if (!has0xPrefix(inputTx)) {
      inputTx = '0x' + inputTx;
    }

    const transaction = rawTxToStacksTransaction(inputTx);
    const checkSigned = isSignedTransaction(transaction);
    if (signed != checkSigned) {
      res.status(400).json(RosettaErrors.invalidParams);
      return;
    }
    try {
      const operations = getOperations(rawTxToBaseTx(inputTx));
      let response;
      if (signed) {
        response = {
          operations: operations,
          account_identifier_signers: getSigners(transaction),
        };
      } else {
        response = {
          operations: operations,
        };
      }
      res.json(response);
    } catch (error) {
      console.error(error);
    }
  });

  //construction/submit endpoint
  router.postAsync('/submit', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body);
    if (!valid.valid) {
      res.status(400).json(makeRosettaError(valid));
      return;
    }
    let transaction = req.body.signed_transaction;
    let buffer: Buffer;

    if (!has0xPrefix(transaction)) {
      transaction = '0x' + transaction;
    }

    try {
      buffer = hexToBuffer(transaction);
    } catch (error) {
      res.status(400).json(RosettaErrors.invalidTransactionString);
      return;
    }
    try {
      const submitResult = await new StacksCoreRpcClient().sendTransaction(buffer);
      const response: RosettaConstructionSubmitResponse = {
        transaction_identifier: {
          hash: submitResult.txId,
        },
      };
      res.status(200).json(response);
    } catch {
      res.status(400).json(RosettaErrors.invalidTransactionString);
    }
  });

  //construction/payloads endpoint
  router.postAsync('/payloads', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body);
    if (!valid.valid) {
      res.status(400).json(makeRosettaError(valid));
      return;
    }

    const options = getOptionsFromOperations(req.body.operations);
    if (options == null) {
      res.status(400).json(RosettaErrors.invalidOperation);
      return;
    }

    const amount = options.amount;
    if (!amount) {
      res.status(400).json(RosettaErrors.invalidAmount);
      return;
    }

    const fees = options.fee;
    if (!fees) {
      res.status(400).json(RosettaErrors.invalidFees);
      return;
    }

    const publicKeys: RosettaPublicKey[] = req.body.public_keys;
    if (!publicKeys) {
      res.status(400).json(RosettaErrors.emptyPublicKey);
      return;
    }

    const recipientAddress = options.token_transfer_recipient_address;
    if (!recipientAddress) {
      res.status(400).json(RosettaErrors.invalidRecipient);
      return;
    }
    const senderAddress = options.sender_address;

    if (!senderAddress) {
      res.status(400).json(RosettaErrors.invalidSender);
      return;
    }

    const accountInfo = await new StacksCoreRpcClient().getAccount(senderAddress);

    let tokenTransferOptions: UnsignedTokenTransferOptions | UnsignedMultiSigTokenTransferOptions;

    if (publicKeys.length !== 1) {
      //TODO support multi-sig in the future.
      res.status(400).json(RosettaErrors.needOnePublicKey);
      return;
    } else {
      if (publicKeys[0].curve_type !== 'secp256k1') {
        res.status(400).json(RosettaErrors.invalidCurveType);
        return;
      }
      // signel signature
      tokenTransferOptions = {
        recipient: recipientAddress,
        amount: new BN(amount),
        fee: new BN(fees),
        publicKey: publicKeys[0].hex_bytes,
        network: GetStacksTestnetNetwork(),
        nonce: accountInfo.nonce ? new BN(accountInfo.nonce) : new BN(0),
      };
    }

    const transaction = await makeUnsignedSTXTokenTransfer(tokenTransferOptions);
    const unsignedTransaction = transaction.serialize();

    const signer = new TransactionSigner(transaction);

    const prehash = makeSigHashPreSign(
      signer.sigHash,
      AuthType.Standard,
      new BN(fees),
      accountInfo.nonce ? new BN(accountInfo.nonce) : new BN(0)
    );

    const response: RosettaConstructionPayloadResponse = {
      unsigned_transaction: '0x' + unsignedTransaction.toString('hex'),
      payloads: [
        {
          address: senderAddress,
          hex_bytes: prehash,
          signature_type: 'ecdsa_recovery',
        },
      ],
    };
    res.json(response);
  });

  //construction/combine endpoint
  router.postAsync('/combine', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body);
    if (!valid.valid) {
      res.status(400).json(makeRosettaError(valid));
      return;
    }
    const combineRequest: RosettaConstructionCombineRequest = req.body;
    const signatures = combineRequest.signatures;

    if (!has0xPrefix(combineRequest.unsigned_transaction)) {
      combineRequest.unsigned_transaction = '0x' + combineRequest.unsigned_transaction;
    }

    if (signatures.length === 0) {
      res.status(400).json(RosettaErrors.noSignatures);
      return;
    }

    let unsigned_transaction_buffer: Buffer;
    let transaction: StacksTransaction;

    try {
      unsigned_transaction_buffer = hexToBuffer(combineRequest.unsigned_transaction);
      transaction = deserializeTransaction(BufferReader.fromBuffer(unsigned_transaction_buffer));
    } catch (e) {
      res.status(400).json(RosettaErrors.invalidTransactionString);
      return;
    }

    if (signatures.length !== 1) res.status(400).json(RosettaErrors.needOnlyOneSignature);

    if (signatures[0].public_key.curve_type !== 'secp256k1') {
      res.status(400).json(RosettaErrors.invalidCurveType);
      return;
    }
    const preSignHash = makePresignHash(transaction);
    if (!preSignHash) {
      res.status(400).json(RosettaErrors.invalidTransactionString);
      return;
    }

    let newSignature: MessageSignature;

    try {
      /**
       * the elliptic library produces signatures that aren't in an "allowed" format
       * it preapend v (i.e 01) while it should append it at the end, to incorporate that rotate
       * the signature to match the elipcitc library
       * Discussion here: https://github.com/coinbase/rosetta-sdk-go/issues/201
       */
      let hash = signatures[0].hex_bytes;
      if (!hash.startsWith('01') && hash.slice(128) == '01') {
        hash = signatures[0].hex_bytes.slice(128) + signatures[0].hex_bytes.slice(0, -2);
      }
      newSignature = createMessageSignature(hash);
    } catch (error) {
      res.status(400).json(RosettaErrors.invalidSignature);
      return;
    }

    if (has0xPrefix(signatures[0].public_key.hex_bytes)) {
      signatures[0].signing_payload.hex_bytes = signatures[0].signing_payload.hex_bytes.replace(
        '0x',
        ''
      );
    }

    if (
      !verifySignature(
        signatures[0].signing_payload.hex_bytes,
        signatures[0].public_key.hex_bytes,
        newSignature
      )
    ) {
      res.status(400).json(RosettaErrors.signatureNotVerified);
    }

    if (transaction.auth.spendingCondition && isSingleSig(transaction.auth.spendingCondition)) {
      transaction.auth.spendingCondition.signature = newSignature;
    } else {
      //support multi-sig
    }

    const serializedTx = transaction.serialize().toString('hex');

    const combineResponse: RosettaConstructionCombineResponse = {
      signed_transaction: '0x' + serializedTx,
    };

    res.status(200).json(combineResponse);
  });

  return router;
}