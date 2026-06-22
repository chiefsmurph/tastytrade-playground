// Shared runtime types used across the project

export interface AccountBalance {
  [key: string]: unknown;
  accountNumber?: string;
  account_number?: string;
  cashBalance?: number;
  cash_balance?: number;
  longEquityValue?: number;
  long_equity_value?: number;
  shortEquityValue?: number;
  short_equity_value?: number;
  longDerivativeValue?: number;
  long_derivative_value?: number;
  shortDerivativeValue?: number;
  short_derivative_value?: number;
  longFuturesValue?: number;
  long_futures_value?: number;
  shortFuturesValue?: number;
  short_futures_value?: number;
  longFuturesDerivativeValue?: number;
  long_futures_derivative_value?: number;
  shortFuturesDerivativeValue?: number;
  short_futures_derivative_value?: number;
  longMargineableValue?: number;
  long_margineable_value?: number;
  shortMargineableValue?: number;
  short_margineable_value?: number;
  marginEquity?: number;
  margin_equity?: number;
  equityBuyingPower?: number;
  equity_buying_power?: number;
  derivativeBuyingPower?: number;
  derivative_buying_power?: number;
  dayTradingBuyingPower?: number;
  day_trading_buying_power?: number;
  futuresMarginRequirement?: number;
  futures_margin_requirement?: number;
  availableTradingFunds?: number;
  available_trading_funds?: number;
  maintenanceRequirement?: number;
  maintenance_requirement?: number;
  maintenanceCallValue?: number;
  maintenance_call_value?: number;
  regTCallValue?: number;
  reg_t_call_value?: number;
  dayTradingCallValue?: number;
  day_trading_call_value?: number;
  dayEquityCallValue?: number;
  day_equity_call_value?: number;
  netLiquidatingValue?: number;
  net_liquidating_value?: number;
  cashAvailableToWithdraw?: number;
  cash_available_to_withdraw?: number;
  dayTradeExcess?: number;
  day_trade_excess?: number;
  pendingCash?: number;
  pending_cash?: number;
  pendingCashEffect?: string | null;
  pending_cash_effect?: string | null;
  longCryptocurrencyValue?: number;
  long_cryptocurrency_value?: number;
  shortCryptocurrencyValue?: number;
  short_cryptocurrency_value?: number;
  cryptocurrencyMarginRequirement?: number;
  cryptocurrency_margin_requirement?: number;
  unsettledCryptocurrencyFiatAmount?: number;
  unsettled_cryptocurrency_fiat_amount?: number;
  unsettledCryptocurrencyFiatEffect?: string | null;
  unsettled_cryptocurrency_fiat_effect?: string | null;
  closedLoopAvailableBalance?: number;
  closed_loop_available_balance?: number;
  equityOfferingMarginRequirement?: number;
  equity_offering_margin_requirement?: number;
  longBondValue?: number;
  long_bond_value?: number;
  bondMarginRequirement?: number;
  bond_margin_requirement?: number;
  snapshotDate?: string | Date;
  snapshot_date?: string | Date;
  regTMarginRequirement?: number;
  reg_t_margin_requirement?: number;
  futuresOvernightMarginRequirement?: number;
  futures_overnight_margin_requirement?: number;
  futuresIntradayMarginRequirement?: number;
  futures_intraday_margin_requirement?: number;
  maintenanceExcess?: number;
  maintenance_excess?: number;
  pendingMarginInterest?: number;
  pending_margin_interest?: number;
  effectiveCryptocurrencyBuyingPower?: number;
  effective_cryptocurrency_buying_power?: number;
  updatedAt?: string | Date;
  updated_at?: string | Date;
  apex_starting_day_margin_equity?: number | null;
  buying_power_adjustment?: any;
  buying_power_adjustment_effect?: any;
  time_of_day?: any;
}

export interface CurrentPosition {
  [key: string]: unknown;
  accountNumber?: string;
  account_number?: string;
  symbol: string;
  orderSymbol?: string;
  quoteSymbol?: string;
  streamerSymbol?: string | null;
  instrumentType?: string; // e.g. 'Equity', 'Option', etc.
  instrument_type?: string;
  underlyingSymbol?: string | null;
  underlying_symbol?: string | null;
  quantity: number;
  quantityDirection?: string | null; // 'Long' | 'Short'
  quantity_direction?: string | null; // 'Long' | 'Short'
  closePrice?: number | null;
  close_price?: number | null;
  averageOpenPrice?: number | null;
  average_open_price?: number | null;
  multiplier?: number | null;
  costEffect?: string | null;
  cost_effect?: string | null;
  isSuppressed?: boolean;
  is_suppressed?: boolean;
  isFrozen?: boolean;
  is_frozen?: boolean;
  realizedDayGain?: number | null;
  realized_day_gain?: number | null;
  realizedToday?: number | null;
  realized_today?: number | null;
  createdAt?: string | Date;
  created_at?: string | Date;
  updatedAt?: string | Date;
  updated_at?: string | Date;
  mark?: number | null;
  markPrice?: number | null;
  mark_price?: number | null;
  restrictedQuantity?: number | null;
  restricted_quantity?: number | null;
  expiresAt?: string | Date | null;
  expires_at?: string | Date | null;
  fixingPrice?: number | null;
  fixing_price?: number | null;
  deliverableType?: string | null;
  deliverable_type?: string | null;
  averageYearlyMarketClosePrice?: number | null;
  average_yearly_market_close_price?: number | null;
  averageDailyMarketClosePrice?: number | null;
  average_daily_market_close_price?: number | null;
  realizedDayGainEffect?: string | null;
  realized_day_gain_effect?: string | null;
  realizedDayGainDate?: string | Date | null;
  realized_day_gain_date?: string | Date | null;
  realizedTodayEffect?: string | null;
  realized_today_effect?: string | null;
  realizedTodayDate?: string | Date | null;
  realized_today_date?: string | Date | null;
  normalizationErrors?: string[];
}

export type InstrumentType = 'Equity' | 'Option' | 'Future' | string;

// Option chain types
export interface TickSize {
  threshold?: string;
  value: string;
}

export interface Deliverable {
  id: number;
  amount: string;
  'deliverable-type': string;
  description: string;
  'instrument-type': string;
  percent: string;
  'root-symbol': string;
  symbol: string;
}

export interface Strike {
  'strike-price': string;
  call?: string;
  'call-streamer-symbol'?: string;
  put?: string;
  'put-streamer-symbol'?: string;
}

export interface Expiration {
  'expiration-type': string;
  'expiration-date': string;
  'days-to-expiration': number;
  'settlement-type': string;
  strikes: Strike[];
}

export interface OptionChain {
  'underlying-symbol': string;
  'root-symbol': string;
  'option-chain-type': string;
  'shares-per-contract': number;
  'tick-sizes'?: TickSize[];
  'deliverables'?: Deliverable[];
  expirations: Expiration[];
}

export type OptionChains = OptionChain[];

// Volume-augmented variants
export interface StrikeWithVolumes extends Strike {
  callDayVolume?: number;
  callOpenInterest?: number;
  callVolume?: number;
  putDayVolume?: number;
  putOpenInterest?: number;
  putVolume?: number;
  dayVolume?: number;
  openInterest?: number;
  volume?: number; // generic fallback
}

export interface ExpirationWithVolumes extends Omit<Expiration, 'strikes'> {
  strikes: StrikeWithVolumes[];
}

export interface OptionChainWithVolumes extends Omit<OptionChain, 'expirations'> {
  expirations: ExpirationWithVolumes[];
}

export type OptionChainsWithVolumes = OptionChainWithVolumes[];
