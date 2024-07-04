import {
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
  Connection,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  closeAccount,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getMint,
} from "@solana/spl-token";
import {
  connection,
  deployerPubkey,
  payerKeypair,
  privateKeys,
  distributionPerWallet,
  tokenDecimal,
  buySolAmounts,
  jitoFee,
  commitment,
} from "./config";
import {
  bufferFromUInt64,
  createTransaction,
  generateDistribution,
  saveDataToFile,
  sendAndConfirmTransactionWrapper,
  sleep,
} from "./utility";
import {
  GLOBAL,
  FEE_RECIPIENT,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  RENT,
  PUMP_FUN_ACCOUNT,
  PUMP_FUN_PROGRAM,
  UNIT_PRICE,
  UNIT_BUDGET,
  CHECK_FILTER,
  JITO_MODE,
  JITO_ALL,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  ASSOC_TOKEN_ACC_PROG,
} from "./constants";
// import base58 from "bs58";
// import { sendBulkToken } from "./sendBulk";
// import { commitment } from "./constants";
import { filterToken } from "./tokenFilter";
import { BONDINGCURVECUSTOM, BONDING_CURV } from "./layout";
import { logger } from "./utility/index";
import { bundle } from "./executor/executor";
import { execute } from "./executor/legacy";
import BN from "bn.js";

const existingLiquidityPools: Set<string> = new Set<string>();

let poolId: PublicKey;

let isBuying = false;
let isBought = false;
let globalLogListener: number | null = null

const runListener = async () => {
  // await init();

  try {
    globalLogListener = connection.onLogs(
      PUMP_FUN_PROGRAM,
      async ({ logs, err, signature }) => {
        const isMint = logs.filter(log => log.includes("MintTo")).length;
        if (!isBuying && isMint && !isBought) {
          isBuying = true
          console.log("\n-------------Found new token in the pump.fun:-------------------\n")
          console.log("signature: ", signature);

          const parsedTransaction = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
          if (!parsedTransaction) {
            console.log("bad Transaction, signature: ", signature);
            isBuying = false
            return;
          }

          const wallet = parsedTransaction?.transaction.message.accountKeys[0].pubkey;
          const mint = parsedTransaction?.transaction.message.accountKeys[1].pubkey;
          const tokenPoolAta = parsedTransaction?.transaction.message.accountKeys[4].pubkey;
          console.log("mint:", mint)
          console.log("tokenPoolAta:", tokenPoolAta)
          console.log("wallet:", wallet)

          if (CHECK_FILTER) {
            const buyable = await filterToken(connection, mint!, commitment, wallet!, tokenPoolAta!);

            console.log("🚀 ~ Token is Buyable:", buyable)
            if (buyable) {
              console.log("Buy tokens here!");

              console.log("-------Token Buy start----------");

              try {
                connection.removeOnLogsListener(globalLogListener!)
                console.log("Global listener is removed!");
              } catch(err) {
                console.log(err);
              }

              await buy(payerKeypair, mint, 0.001, 10);

              console.log("-------Token Buy end----------");

              const buyerAta = await getAssociatedTokenAddress(mint, payerKeypair.publicKey)
              console.log("BuyerAta: ", buyerAta);
              const balance = (await connection.getTokenAccountBalance(buyerAta)).value.amount
              console.log("BuyerAtaBalance: ", balance);
              
              console.log("-------Token Sell start----------");

              if(!balance) {
                console.log("There is no token in this wallet.");
              } else {
                await sell(payerKeypair, mint, Number(balance), 0.00002, 1, buyerAta);
              }

                // await sell(payerKeypair, new PublicKey("PwPQqY8XQavXYyPeTj3nYRCrTCE4HFHAwKrKcTWpump"), 6524, 0.00002, 1, new PublicKey("FYUyCGvqPCHnALJ9H6RAuhXzemPyKqBWL8a4J8HipCKS"));

              console.log("-------Token Sell end----------");
              
              console.log("-------Close Associated Token Account start----------");

              // await closeAccount(connection, payerKeypair, buyerAta, payerKeypair.publicKey, payerKeypair)
              console.log("Closed accounts successfully.");
              
              console.log("-------Close Associated Token Account end----------");

            }
          }
          isBuying = false
          console.log("isBuying: ", isBuying);
          if(isBought) process.exit(1);
        }
      },
      commitment
    );
  } catch (err) {
    console.log(err);
  }
};

export const buy = async (
  keypair: Keypair,
  mint: PublicKey,
  solIn: number,
  slippageDecimal: number = 0.01
) => {

  console.log("Payer wallet public key is", payerKeypair.publicKey.toBase58())
  const buyerKeypair = keypair
  const buyerWallet = buyerKeypair.publicKey;
  const tokenMint = mint
  let buyerAta = await getAssociatedTokenAddress(tokenMint, buyerWallet)

  try {
    const transactions: VersionedTransaction[] = []

    console.log("🚀 ~ buyerAta:", buyerAta)

    let ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: UNIT_PRICE }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: UNIT_BUDGET })
    ];

    // Attempt to retrieve token account, otherwise create associated token account
    try {
      const buyerTokenAccountInfo = await connection.getAccountInfo(buyerAta, "processed")
      if (!buyerTokenAccountInfo) {
        ixs.push(
          createAssociatedTokenAccountInstruction(
            buyerWallet,
            buyerAta,
            buyerWallet,
            tokenMint,
          )
        )
      }
    } catch (error) {
      console.log(error)
      return
    }

    const TRADE_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    const BONDING_ADDR_SEED = new Uint8Array([98, 111, 110, 100, 105, 110, 103, 45, 99, 117, 114, 118, 101]);

    // get the address of bonding curve and associated bonding curve
    const [bonding] = PublicKey.findProgramAddressSync([BONDING_ADDR_SEED, tokenMint.toBuffer()], TRADE_PROGRAM_ID);
    const [assoc_bonding_addr] = PublicKey.findProgramAddressSync([bonding.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), tokenMint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);

    // get the accountinfo of bonding curve
    const accountInfo = await connection.getAccountInfo(bonding, "processed")
    console.log("🚀 ~ accountInfo:", accountInfo)

    if (!accountInfo) return

    // get the poolstate of the bonding curve
    const poolState = BONDING_CURV.decode(
      accountInfo.data
    );
    console.log("🚀 ~ poolState:", poolState)
    console.log("virtualTokenReserves: ", poolState.virtualTokenReservs.toString());
    console.log("realTokenReserves: ", poolState.realTokenReserves.toString());
    // Calculate tokens out
    const virtualSolReserves = poolState.virtualSolReserves;
    const virtualTokenReserves = poolState.virtualTokenReservs;
    // const solIn = solIns[i]
    const solInLamports = solIn * LAMPORTS_PER_SOL;
    console.log("🚀 ~ solInLamports:", solInLamports)
    const tokenOut = Math.round(solInLamports * (virtualTokenReserves.div(virtualSolReserves)).toNumber());
    console.log("🚀 ~ tokenOut:", tokenOut)

    const ATA_USER = buyerAta;
    const USER = buyerWallet;
    console.log("🚀 ~ buyerAta:", buyerAta)
    console.log("🚀 ~ buyerWallet:", buyerWallet)

    // Build account key list
    const keys = [
      { pubkey: GLOBAL, isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: bonding, isSigner: false, isWritable: true },
      { pubkey: assoc_bonding_addr, isSigner: false, isWritable: true },
      { pubkey: ATA_USER, isSigner: false, isWritable: true },
      { pubkey: USER, isSigner: true, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: RENT, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false }
    ];

    keys.map(async ({ pubkey }, i) => {
      const info = await connection.getAccountInfo(pubkey, "confirmed")
      if (!info) console.log(pubkey.toBase58(), " address info : null : ", i)
    })

    // Calculating the slippage process
    const calc_slippage_up = (sol_amount: number, slippage: number): number => {
      const lamports = sol_amount * LAMPORTS_PER_SOL;
      // return Math.round(lamports * (1 + slippage));
      return Math.round(lamports / 1000 * (1 + slippage) + lamports / 1000 * (1 + slippage));
    }

    const instruction_buf = Buffer.from('66063d1201daebea', 'hex');
    const token_amount_buf = Buffer.alloc(8);
    token_amount_buf.writeBigUInt64LE(BigInt(tokenOut), 0);
    const slippage_buf = Buffer.alloc(8);
    slippage_buf.writeBigUInt64LE(BigInt(calc_slippage_up(solInLamports, slippageDecimal)), 0);
    const data = Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);

    const swapInstruction = new TransactionInstruction({
      keys: keys,
      programId: PUMP_FUN_PROGRAM,
      data: data
    })

    ixs.push(swapInstruction)
    const blockhash = await connection.getLatestBlockhash("confirmed")

    // simulation process
    // const tx = new Transaction().add(...ixs)
    // tx.recentBlockhash = blockhash
    // tx.feePayer = buyerWallet

    // Compile message
    const messageV0 = new TransactionMessage({
      payerKey: buyerWallet,
      recentBlockhash: blockhash.blockhash,
      instructions: ixs,
    }).compileToV0Message()
    const transaction = new VersionedTransaction(messageV0)
    transaction.sign([buyerKeypair])
    console.log("==============================================")
    console.log(await connection.simulateTransaction(transaction, { commitment: "processed" }))
    // transactions.push(transaction)

    // Bundling process
    console.log("JITO_MODE:", JITO_MODE);

    if (JITO_MODE) {
      const result = await bundle([transaction], buyerKeypair, connection)
      console.log("Bundling result: ", result);
    } else {
      await execute(transaction, blockhash)
    }
  } catch (e) {
    logger.debug(e)
    console.log(`Failed to buy token, ${mint}`)
  }

  console.log("---------Checking the result---------")
  let index = 0
  while (true) {
    if (index > 10) {
      console.log("token sniping failed")
      return
    }
    try {
      const tokenBalance = (await connection.getTokenAccountBalance(buyerAta)).value.uiAmount
      if (tokenBalance && tokenBalance > 0) {
        console.log("🚀 ~ tokenBalance:", tokenBalance)
        isBought = true
        break
      }
    } catch (error) {
      index++
      await sleep(1000)
    }
  }
  console.log("Bundling result confirmed, successfully bought")
}









export async function sell(payerKeypair: Keypair, mint: PublicKey, tokenBalance: number, priorityFeeInSol: number = 0, slippageDecimal: number = 0.25, tokenAccountAddress: PublicKey) {
  try {

    const owner = payerKeypair;
    const txBuilder = new Transaction();

    const TRADE_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    const BONDING_ADDR_SEED = new Uint8Array([98, 111, 110, 100, 105, 110, 103, 45, 99, 117, 114, 118, 101]);

    // get the address of bonding curve and associated bonding curve
    const [bonding] = PublicKey.findProgramAddressSync([BONDING_ADDR_SEED, mint.toBuffer()], TRADE_PROGRAM_ID);
    const [assoc_bonding_addr] = PublicKey.findProgramAddressSync([bonding.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);

    // get the accountinfo of bonding curve
    const accountInfo = await connection.getAccountInfo(bonding, "processed")
    console.log("🚀 ~ accountInfo:", accountInfo)

    if(!accountInfo) return

    // get the poolstate of the bonding curve
    const poolState = BONDING_CURV.decode(
      accountInfo.data
    );
    console.log("🚀 ~ poolState:", poolState)
    console.log("virtualTokenReserves: ", poolState.virtualTokenReservs.toString());
    console.log("realTokenReserves: ", poolState.realTokenReserves.toString());
    // Calculate tokens out
    const virtualSolReserves = poolState.virtualSolReserves;
    const virtualTokenReserves = poolState.virtualTokenReservs;

    console.log("virtualSolReserves: ", virtualSolReserves.toString());
    console.log("virtualTokenReserves", virtualTokenReserves.toString());

    const tokenAccountInfo = await connection.getAccountInfo(tokenAccountAddress);

    let tokenAccount: PublicKey;
    if (!tokenAccountInfo) {
      txBuilder.add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          tokenAccountAddress,
          owner.publicKey,
          mint
        )
      );
      tokenAccount = tokenAccountAddress;
    } else {
      tokenAccount = tokenAccountAddress;
    }

    console.log("Before the calculation of minSol:");
    const minSolOutput = Math.floor(tokenBalance * (1 - slippageDecimal) * (virtualSolReserves.mul(new BN(1000000)).div(virtualTokenReserves)).toNumber());
    console.log("After the calculation of minSol: ", minSolOutput);

    const keys = [
      { pubkey: GLOBAL, isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bonding, isSigner: false, isWritable: true },
      { pubkey: assoc_bonding_addr, isSigner: false, isWritable: true },
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ASSOC_TOKEN_ACC_PROG, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false }
    ];

    const data = Buffer.concat([
      bufferFromUInt64("12502976635542562355"),
      bufferFromUInt64(tokenBalance),
      bufferFromUInt64(minSolOutput)
    ]);

    const instruction = new TransactionInstruction({
      keys: keys,
      programId: PUMP_FUN_PROGRAM,
      data: data
    });
    txBuilder.add(instruction);

    const transaction = await createTransaction(connection, txBuilder.instructions, owner.publicKey, priorityFeeInSol);
    console.log(await connection.simulateTransaction(transaction))


    const signature = await sendAndConfirmTransactionWrapper(connection, transaction, [owner]);
    if(signature) console.log('Sell transaction confirmed:', signature);
  }
  catch (error) {
    console.log(error)
  }
}



runListener()
// sell(payerKeypair, new PublicKey("2qjuitee5a4brvEDLb196mn3Fmb1efb9o6k27rR7cQHg"), 6492000000, 0.00002, 1, new PublicKey("3K7YAGdkhdu8pDDjtpq6idf6x3jpmgi38ib28vCxemnb"))
