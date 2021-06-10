import {
  DataStore,
  DbFungibleTokenMetadata,
  DbNonFungibleTokenMetadata,
} from '../datastore/common';
import {
  callReadOnlyFunction,
  ChainID,
  ClarityAbi,
  ClarityAbiFunction,
  ClarityType,
  ClarityValue,
  getAddressFromPrivateKey,
  makeRandomPrivKey,
  ReadOnlyFunctionOptions,
  StringAsciiCV,
  TransactionVersion,
  UIntCV,
} from '@stacks/transactions';
import { GetStacksNetwork } from '../bns-helpers';
import { logError, logger } from '../helpers';
import * as URI from 'uri-js';
import { StacksNetwork } from '@stacks/network';

const PUBLIC_IPFS = 'https://ipfs.io';

const FT_FUNCTIONS: ClarityAbiFunction[] = [
  {
    access: 'public',
    args: [
      { type: 'uint128', name: 'amount' },
      { type: 'principal', name: 'sender' },
      { type: 'principal', name: 'recipient' },
      { type: { optional: { buffer: { length: 34 } } }, name: 'memo' },
    ],
    name: 'transfer',
    outputs: { type: { response: { ok: 'bool', error: 'uint128' } } },
  },
  {
    access: 'read_only',
    args: [],
    name: 'get-name',
    outputs: { type: { response: { ok: { 'string-ascii': { length: 32 } }, error: 'uint128' } } },
  },
  {
    access: 'read_only',
    args: [],
    name: 'get-symbol',
    outputs: { type: { response: { ok: { 'string-ascii': { length: 32 } }, error: 'uint128' } } },
  },
  {
    access: 'read_only',
    args: [],
    name: 'get-decimals',
    outputs: { type: { response: { ok: 'uint128', error: 'uint128' } } },
  },
  {
    access: 'read_only',
    args: [{ type: 'principal', name: 'address' }],
    name: 'get-balance-of',
    outputs: { type: { response: { ok: 'uint128', error: 'uint128' } } },
  },
  {
    access: 'read_only',
    args: [],
    name: 'get-total-supply',
    outputs: { type: { response: { ok: 'uint128', error: 'uint128' } } },
  },
  {
    access: 'read_only',
    args: [],
    name: 'get-token-uri',
    outputs: {
      type: {
        response: {
          ok: {
            optional: { 'string-ascii': { length: 256 } },
          },
          error: 'uint128',
        },
      },
    },
  },
];

const NFT_FUNCTIONS: ClarityAbiFunction[] = [
  {
    access: 'read_only',
    args: [],
    name: 'get-last-token-id',
    outputs: {
      type: {
        response: {
          ok: 'uint128',
          error: 'uint128',
        },
      },
    },
  },
  {
    access: 'read_only',
    args: [{ name: 'any', type: 'uint128' }],
    name: 'get-token-uri',
    outputs: {
      type: {
        response: {
          ok: {
            optional: { 'string-ascii': { length: 256 } },
          },
          error: 'uint128',
        },
      },
    },
  },
  {
    access: 'read_only',
    args: [{ type: 'uint128', name: 'any' }],
    name: 'get-owner',
    outputs: {
      type: {
        response: {
          ok: {
            optional: 'principal',
          },
          error: 'uint128',
        },
      },
    },
  },
  {
    access: 'public',
    args: [
      { type: 'uint128', name: 'id' },
      { type: 'principal', name: 'sender' },
      { type: 'principal', name: 'recipient' },
    ],
    name: 'transfer',
    outputs: {
      type: {
        response: {
          ok: 'bool',
          error: {
            tuple: [
              { type: { 'string-ascii': { length: 32 } }, name: 'kind' },
              { type: 'uint128', name: 'code' },
            ],
          },
        },
      },
    },
  },
];

interface TokenMetadata {
  name: string;
  imageUrl: string;
  description: string;
}

export class TokensContractHandler {
  private contractAddress: string;
  private contractName: string;
  private contractAbi: ClarityAbi;
  private db: DataStore;
  private randomPrivKey = makeRandomPrivKey();
  private chainId: ChainID;
  private stacksNetwork: StacksNetwork;
  private address: string;

  constructor(
    contractAddress: string,
    contractName: string,
    smartContractAbi: ClarityAbi,
    datastore: DataStore,
    chainId: ChainID
  ) {
    this.contractAddress = contractAddress;
    this.contractName = contractName;
    this.contractAbi = smartContractAbi;
    this.db = datastore;
    this.chainId = chainId;

    this.stacksNetwork = GetStacksNetwork(this.chainId);
    this.address = getAddressFromPrivateKey(
      this.randomPrivKey.data,
      this.chainId === ChainID.Mainnet ? TransactionVersion.Mainnet : TransactionVersion.Testnet
    );
  }
  async start() {
    if (this.contractAbi.fungible_tokens.length > 0) {
      if (this.isCompliant(FT_FUNCTIONS)) {
        await this.handleFTContract();
      }
    }

    if (this.contractAbi.non_fungible_tokens.length > 0) {
      if (this.isCompliant(NFT_FUNCTIONS)) {
        await this.handleNFTContract();
      }
    }
  }

  /**
   * fetch Fungible contract metadata
   */
  private async handleFTContract() {
    const contractCallName = await this.makeReadOnlyContractCall('get-name', []);
    const contractCallUri = await this.makeReadOnlyContractCall('get-token-uri', []);
    const contractCallSymbol = await this.makeReadOnlyContractCall('get-symbol', []);
    const contractCallDecimals = await this.makeReadOnlyContractCall('get-decimals', []);

    const nameCV = this.checkAndParseString(contractCallName);
    const uriCV = this.checkAndParseOptionalString(contractCallUri);
    const symbolCV = this.checkAndParseString(contractCallSymbol);
    const decimalsCV = this.checkAndParseUintCV(contractCallDecimals);

    if (uriCV) {
      const metadata = await this.getMetadataFromUri(uriCV.data);

      const fungibleTokenMetadata: DbFungibleTokenMetadata = {
        name: nameCV ? nameCV.data : metadata.name, //prefer the on-chain name
        description: metadata.description,
        image_uri: metadata.imageUrl,
        image_canonical_uri: uriCV.data,
        symbol: symbolCV ? symbolCV.data : '',
        decimals: decimalsCV ? decimalsCV.value : 0,
        contract_id: `${this.contractAddress}.${this.contractName}`,
      };

      await this.storeFTMetadata(fungibleTokenMetadata);
    }
  }

  /**
   * fetch Non Fungible contract metadata
   */
  private async handleNFTContract() {
    const contractCallTokenId = await this.makeReadOnlyContractCall('get-last-token-id', []);
    const tokenId = this.checkAndParseUintCV(contractCallTokenId);

    if (tokenId) {
      const contractCallUri = await this.makeReadOnlyContractCall('get-token-uri', [tokenId]);
      const uriCV = this.checkAndParseOptionalString(contractCallUri);

      if (uriCV) {
        const metadata = await this.getMetadataFromUri(uriCV.data);
        const nonFungibleTokenMetadata: DbNonFungibleTokenMetadata = {
          name: metadata.name,
          description: metadata.description,
          image_uri: metadata.imageUrl,
          image_canonical_uri: uriCV.data,
          contract_id: `${this.contractAddress}.${this.contractName}`,
        };
        await this.storeNFTMetadata(nonFungibleTokenMetadata);
      }
    }
  }

  /**helpng method for creating ipfs url */
  private makeHostedUrl(uri: string) {
    const parsedURI = URI.parse(uri);
    return `${PUBLIC_IPFS}/${parsedURI.host}${parsedURI.path}`;
  }

  async makeApiCall(url: string): Promise<TokenMetadata> {
    const result = await fetch(url);
    if (!result.ok) {
      let msg = '';
      try {
        msg = await result.text();
      } catch (error) {
        logError(`Error getting text`, error);
      }
      throw new Error(`Response ${result.status}: ${result.statusText} fetching ${url} - ${msg}`);
    }
    try {
      const resultString = await result.text();
      return JSON.parse(resultString) as TokenMetadata;
    } catch (error) {
      logError(`Error reading response from ${url}`, error);
      throw error;
    }
  }
  /**
   * fetch metadata from ipfs uri
   */
  private async getMetadataFromUri(token_uri: string): Promise<TokenMetadata> {
    return await this.makeApiCall(this.makeHostedUrl(token_uri));
  }

  /**
   * make readonly contract call
   */

  private async makeReadOnlyContractCall(
    functionName: string,
    functionArgs: ClarityValue[]
  ): Promise<ClarityValue> {
    const txOptions: ReadOnlyFunctionOptions = {
      senderAddress: this.address,
      contractAddress: this.contractAddress,
      contractName: this.contractName,
      functionName: functionName,
      functionArgs: functionArgs,
      network: this.stacksNetwork,
    };
    return await callReadOnlyFunction(txOptions);
  }

  /**
   *Store ft metadata to db
   */
  private async storeFTMetadata(ft_metadata: DbFungibleTokenMetadata) {
    try {
      await this.db.updateFtMetadata(ft_metadata);
    } catch (error) {
      logger.error(`Error: error occured while updating FT metadata`);
    }
  }

  /**
   *store NFT Metadata to db
   */
  private async storeNFTMetadata(nft_metadata: DbNonFungibleTokenMetadata) {
    try {
      await this.db.updateNFtMetadata(nft_metadata);
    } catch (error) {
      logger.error(`Error: error occured while updating NFT metadata`);
    }
  }

  /**
   * This method check if the contract is compliance with sip-09 and sip-10
   * Ref: https://github.com/stacksgov/sips/tree/main/sips
   */
  private isCompliant(standardFunction: ClarityAbiFunction[]): boolean {
    return standardFunction.every(abiFun => this.findFunction(abiFun, this.contractAbi.functions));
  }

  /**
   * check if the fun  exist in the function list
   * @param fun - function to be found
   * @param functionList - list of functions
   * @returns - true if function is in the list false otherwise
   */
  private findFunction(fun: ClarityAbiFunction, functionList: ClarityAbiFunction[]): boolean {
    const found = functionList.find(standardFunction => {
      if (standardFunction.name === fun.name && standardFunction.args.length === fun.args.length) {
        if (standardFunction.args.length > 0) {
          standardFunction.args.forEach((value, index) => {
            if (value != fun.args[index]) {
              return false;
            }
          });
        }
        return true;
      }
      return false;
    });
    return found != undefined;
  }

  private checkAndParseUintCV(responseCV: ClarityValue): UIntCV | undefined {
    if (responseCV.type == ClarityType.ResponseOk && responseCV.value.type == ClarityType.UInt) {
      return responseCV.value;
    }
    return;
  }

  private checkAndParseOptionalString(responseCV: ClarityValue): StringAsciiCV | undefined {
    if (
      responseCV.type == ClarityType.ResponseOk &&
      responseCV.value.type == ClarityType.OptionalSome &&
      responseCV.value.value.type == ClarityType.StringASCII
    ) {
      return responseCV.value.value;
    }
  }

  private checkAndParseString(responseCV: ClarityValue): StringAsciiCV | undefined {
    if (
      responseCV.type == ClarityType.ResponseOk &&
      responseCV.value.type == ClarityType.StringASCII
    ) {
      return responseCV.value;
    }
  }
}

/**
 * This method checks if a the contract abi has fungible or non fungible tokens
 * @param contract_abi -  clarity abi of the contract
 * @returns true if has tokens false if does not
 */
export function hasTokens(contract_abi: ClarityAbi): boolean {
  return contract_abi.fungible_tokens.length > 0 || contract_abi.non_fungible_tokens.length > 0;
}