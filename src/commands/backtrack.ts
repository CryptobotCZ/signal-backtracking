import { writeJson } from "https://deno.land/x/jsonfile@1.0.0/write_json.ts";
import { exportCsv } from "../output/csv.ts";

import {
  AbstractState,
  backtrack,
  getBackTrackEngine,
  Order,
  TradeResult,
} from "../backtrack-engine.ts";
import {
  getTradeDataWithCache,
  TradeData,
} from "../binance-api.ts";
import { CornixConfiguration } from "../cornix.ts";
import {getFileContent, getInput, readInputCandles} from "../import.ts";
import {
    createDurationFormatter,
    getDateFromTimestampOrDateStr,
    getFormattedTradeDuration,
    getTradeDuration
} from "../utils.ts";


export interface DetailedBackTrackResult {
  order: Order;
  info: TradeResult;
  sortedUniqueCrosses: any[];
  tradeData?: TradeData[];
}

interface BackTrackResult {
  events: any[];
  state: AbstractState;
}

export interface PreBacktrackedData {
  order: Order;
  info: any;
  sortedUniqueCrosses: any[];
  tradeData: TradeData[];
}

export interface BackTrackArgs {
  orderFiles: string[];
  cornixConfigFile: string;
  candlesFiles?: string[];
  downloadBinanceData?: boolean;
  debug?: boolean;
  verbose?: boolean;
  detailedLog?: boolean;
  fromDetailedLog?: boolean;
  fromDate?: string;
  toDate?: string;
  finishRunning?: boolean;
  outputPath?: string;
  anonymize?: boolean;
  locale?: string;
  delimiter?: string;
  cachePath?: string;
}

export const defaultCornixConfig: CornixConfiguration = {
  amount: 100,
  entries: "One Target",
  tps: "Evenly Divided",
  trailingStop: { type: "moving-target", trigger: 1 },
  trailingTakeProfit: 0.02,
};

async function getCornixConfigFromFileOrDefault(cornixConfigFile: string|null, defaultCornixConfig: CornixConfiguration) {
  try {
    const cornixConfig = cornixConfigFile != null
        ? await getFileContent<CornixConfiguration>(cornixConfigFile)
        : defaultCornixConfig;

    return cornixConfig;
  } catch (error) {
    console.error(error);
    return defaultCornixConfig;
  }
}

function getFilteredOrders(orders: Order[], args: BackTrackArgs) {
  if (args.fromDate) {
    const from = getDateFromTimestampOrDateStr(args.fromDate);
    orders = orders.filter((x) => x.date >= from);
  }

  if (args.toDate) {
    const to = getDateFromTimestampOrDateStr(args.toDate);
    orders = orders.filter((x) => x.date <= to);
  }

  return orders;
}

function getSortedUniqueCrosses(result: BackTrackResult) {
  const crosses = result?.events?.filter((x) => x.type === "cross") ?? [];
  const uniqueCrosses: { [key: string]: any } = {};

  crosses.forEach((cross, idx) => {
    const crossType = cross.subtype.indexOf("trailing") === -1
      ? cross.subtype
      : `${cross.subtype}-${idx}`;
    const key = `${crossType}-${cross.id ?? 0}-${cross.direction}`;
    if (!Object.hasOwn(uniqueCrosses, key)) {
      uniqueCrosses[key] = cross;
    }
  });

  const sortedUniqueCrosses = Object.keys(uniqueCrosses)
    .map((x) => uniqueCrosses[x])
    .toSorted((a, b) => a.timestamp - b.timestamp)
    .map(x => ({
      ...x,
      date: new Date(x.timestamp)
    }));

  return sortedUniqueCrosses;
}

function writeSingleTradeResult(results: TradeResult) {
    console.log(`Open time: ${results.openTime}`);
    console.log(`Close time: ${results.closeTime}`);
    console.log(`Is closed: ${results.isClosed}`);
    console.log(`Is cancelled: ${results.isCancelled}`);
    console.log(`Is profitable: ${results.isProfitable}`);
    console.log(`PnL: ${results.pnl?.toFixed(2)}%`);
    console.log(`Profit: ${results.profit?.toFixed(2)}`);
    console.log(`Hit SL: ${results.hitSl}`);
    console.log(`Average entry price: ${results.averageEntryPrice.toFixed(6)}`);
    console.log(`Duration: ${getFormattedTradeDuration(results.openTime, results.closeTime, durationFormatter)}`)
    console.log("---------------------------------------");
}

function calculateResultsSummary(ordersWithResults: DetailedBackTrackResult[]) {
  let totalDuration = 0;
  const summary = ordersWithResults.reduce((sum, curr) => {
    sum.countOrders++;

    const pnlValue = curr.info.pnl ?? 0;
    const pnl = isNaN(pnlValue) ? 0 : pnlValue;

    totalDuration += getTradeDuration(curr.info.openTime, curr.info.closeTime);

    sum.totalPnl += pnl;
    sum.positivePnl += curr.info.isProfitable ? pnl : 0;
    sum.negativePnl += curr.info.isProfitable ? 0 : pnl;

    sum.countProfitable += curr.info.isProfitable ? 1 : 0;
    sum.countSL += (curr.info.hitSl && !curr.info.isProfitable) ? 1 : 0;
    sum.countSlAfterTp += (curr.info.hitSl && curr.info.isProfitable) ? 1 : 0;
    sum.countCancelled += curr.info.isCancelled ? 1 : 0;
    sum.countCancelledProfitable += (curr.info.isCancelled && curr.info.isProfitable) ? 1 : 0;
    sum.countCancelledInLoss += (curr.info.isCancelled && !curr.info.isProfitable) ? 1 : 0;
    sum.totalReachedTps += curr.info.reachedTps;

    sum.averageReachedTps = sum.totalReachedTps / sum.countOrders;
    sum.averagePnl = sum.totalPnl / sum.countOrders;
    sum.averageDuration = totalDuration / sum.countOrders;

    sum.pctSl = sum.countSL / sum.countOrders;

    return sum;
  }, {
    countOrders: 0,
    countProfitable: 0,
    countSL: 0,
    countCancelled: 0,
    countCancelledProfitable: 0,
    countCancelledInLoss: 0,
    countSlAfterTp: 0,
    countFullTp: 0,
    totalPnl: 0,
    averagePnl: 0,
    positivePnl: 0,
    negativePnl: 0,
    totalReachedTps: 0,
    averageReachedTps: 0,
    pctSl: 0,
    averageDuration: 0,
  });

  return summary;
}

function writeResultsSummary(ordersWithResults: DetailedBackTrackResult[]) {
  const summary = calculateResultsSummary(ordersWithResults);

  console.log("----------- Summary results -----------");
  console.log(`Count orders: ${summary.countOrders}`);
  console.log(`Count Profitable: ${summary.countProfitable}`);
  console.log(`Count SL: ${summary.countSL}`);
  console.log(`Count SL after TP: ${summary.countSlAfterTp}`);
  console.log(`Count Cancelled: ${summary.countCancelled}`);
  console.log(`Count Cancelled profitable: ${summary.countCancelledProfitable}`);
  console.log(`Count Cancelled in loss: ${summary.countCancelledInLoss}`);
  console.log(`Count hit all TPs: ${summary.countFullTp}`);
  console.log(`Total PnL: ${summary.totalPnl.toFixed(2)}%`);
  console.log(`PnL of profitable trades: ${summary.positivePnl.toFixed(2)}`);
  console.log(`PnL of SL trades: ${summary.negativePnl.toFixed(2)}`);
  console.log(`Average number of reached TPs: ${summary.averageReachedTps.toFixed(2)}`);
  console.log(`Percentage of SL: ${summary.pctSl.toFixed(2)}`);
  console.log(`Average trade duration: ${durationFormatter(summary.averageDuration)}`)
}

async function writeResultsToFile(ordersWithResults: DetailedBackTrackResult[], args: BackTrackArgs) {
  if (args.detailedLog) {
    const fileName = args.outputPath ?? `backtrack-results-${Date.now()}.json`;
    await writeJson(fileName, ordersWithResults, { spaces: 2 });
  } else if (args.outputPath?.indexOf(".csv") !== -1) {
    const fileName = args.outputPath ?? `backtrack-results-${Date.now()}.csv`;
    await exportCsv(ordersWithResults, fileName, args.anonymize, {
      delimiter: args.delimiter,
      locale: args.locale,
    });
  } else if (args.outputPath?.indexOf(".json") !== -1) {
    const fileName = args.outputPath ?? `backtrack-results-${Date.now()}.json`;
    await writeJson(fileName, ordersWithResults, { spaces: 2 });
  }
}

let durationFormatter = createDurationFormatter('en-US', 'narrow');

export async function backtrackCommand(args: BackTrackArgs) {
  if (args.debug) {
    console.log("Arguments: ");
    console.log(JSON.stringify(args));
  }
  
  if (args.locale) {
    durationFormatter = createDurationFormatter(args.locale, 'narrow');
  }

  const cornixConfig = await getCornixConfigFromFileOrDefault(args.cornixConfigFile, defaultCornixConfig);

  const input = await getInput(args);
  const orders = getFilteredOrders(input.orders, args);
  const tradesMap = input.tradesMap;

  let count = 0;
  const ordersWithResults = [];

  for (const order of orders) {
    try {
      console.log(`Backtracking trade ${order.coin} ${order.direction} ${order.date}`);

      if (args.debug) {
        console.log(JSON.stringify(order));
      }

      performance.mark("backtrack_start");

      let result = null;

      if (args.downloadBinanceData) {
        result = await backtrackWithBinanceUntilTradeCloseOrCurrentDate(
          args,
          order,
          cornixConfig,
        );
      } else {
        const tradeData = tradesMap.get(order)?.tradeData ?? undefined;
        result = await backTrackSingleOrder(
          args,
          order,
          cornixConfig,
          tradeData,
        );
      }

      performance.mark("backtrack_end");
      const time = performance.measure(
        "backtracking",
        "backtrack_start",
        "backtrack_end",
      );

      if (args.debug) {
        console.log(`It took ${time.duration}ms`);
      }

      if (args.debug) {
        const eventsWithoutCross = result.events
            .filter(x => x.type !== 'cross')
            .filter(x => x.level !== 'verbose' || args.verbose)
            .map(x => ({...x, date: new Date(x.timestamp)}));
        eventsWithoutCross.forEach((event) => console.log(JSON.stringify(event)));
      }

      const results = result?.state?.info;
      writeSingleTradeResult(results);

      let sortedUniqueCrosses: any[] = [];

      if (args.detailedLog) {
        sortedUniqueCrosses = getSortedUniqueCrosses(result);
      }

      if (result != null) {
        ordersWithResults.push({
          order,
          info: result.state.info,
          sortedUniqueCrosses: sortedUniqueCrosses.map((x) => {
            const cloneOfX = { ...x };
            delete cloneOfX.tradeData;

            return cloneOfX;
          }),
          events: result.events.filter(x => x.level !== 'verbose' && x.type !== 'cross'),
          tradeData: sortedUniqueCrosses.map((x) => x.tradeData),
        });
      }
    } catch (error) {
      console.error(error);
    }

    count++;

    if (args.debug) {
      const progressPct = (count / orders.length * 100).toFixed(2);
      console.log(`Progress: ${count} / ${orders.length} = ${progressPct}%`);
    }
  }

  writeResultsSummary(ordersWithResults);
  await writeResultsToFile(ordersWithResults, args);
}

async function backTrackSingleOrder(
  args: BackTrackArgs,
  order: Order,
  cornixConfig: CornixConfiguration,
  tradeData?: TradeData[],
): Promise<BackTrackResult> {
  if (tradeData == null && args.candlesFiles) {
    tradeData = await readInputCandles(args.candlesFiles);
  } else if (tradeData == null && (args.downloadBinanceData ?? true)) {
    tradeData = await getTradeDataWithCache(order.coin, "1m", order.date);
  } else if (tradeData == null) {
    throw new Error(
      "Either specify --candlesFiles or use --downloadBinanceData or use --fromDetailedLog",
    );
  }

  const { events, state } = await backtrack(
    cornixConfig,
    order,
    tradeData,
  );

  return { state, events };
}

async function backtrackWithBinanceUntilTradeCloseOrCurrentDate(
  args: BackTrackArgs,
  order: Order,
  cornixConfig: CornixConfiguration,
): Promise<BackTrackResult> {
  // always get full day data
  let currentDate = new Date(new Date(order.date.getTime()).setUTCHours(0, 0, 0, 0));
  let { state, events } = getBackTrackEngine(cornixConfig, order, {
    detailedLog: args.detailedLog,
  });

  do {
    const currentTradeData = await getTradeDataWithCache(
      order.coin,
      "1m",
      currentDate,
    );

    if (currentTradeData.length === 0) {
      break;
    }

    for (const tradeEntry of currentTradeData) {
      let previousState = state;

      do {
        previousState = state;
        state = state.updateState(tradeEntry);
      } while (state != previousState);

      if (state.isClosed) {
        break;
      }
    }

    if (state.isClosed) {
      break;
    }

    currentDate = new Date(currentTradeData.at(-1)?.closeTime!);
  } while (true);

  return { state, events };
}
