import type { Order, OrderRequest, PlacedOrderResponse } from "./types";

type RawOrderService = {
  postReconfirmOrder(accountNumber: string, orderId: number): Promise<unknown>;
  replacementOrderDryRun(
    accountNumber: string,
    orderId: number,
    replacementOrder: object,
  ): Promise<unknown>;
  getOrder(accountNumber: string, orderId: number): Promise<unknown>;
  cancelOrder(accountNumber: string, orderId: number): Promise<unknown>;
  cancelComplexOrder(accountNumber: string, orderId: number): Promise<unknown>;
  replaceOrder(
    accountNumber: string,
    orderId: number,
    replacementOrder: object,
  ): Promise<unknown>;
  editOrder(accountNumber: string, orderId: number, order: object): Promise<unknown>;
  getLiveOrders(accountNumber: string): Promise<unknown>;
  getOrders(accountNumber: string, queryParams?: object): Promise<unknown>;
  createOrder(accountNumber: string, order: object): Promise<unknown>;
  createComplexOrder(accountNumber: string, order: object): Promise<unknown>;
  postOrderDryRun(accountNumber: string, order: object): Promise<unknown>;
  getLiveOrdersForCustomer(customerId: string): Promise<unknown>;
  getCustomerOrders(customerId: string, queryParams?: object): Promise<unknown>;
};

export interface TypedOrderService {
  postReconfirmOrder(accountNumber: string, orderId: number): Promise<PlacedOrderResponse>;
  replacementOrderDryRun(
    accountNumber: string,
    orderId: number,
    replacementOrder: Partial<OrderRequest>,
  ): Promise<PlacedOrderResponse>;
  getOrder(accountNumber: string, orderId: number): Promise<Order>;
  cancelOrder(accountNumber: string, orderId: number): Promise<Order>;
  cancelComplexOrder(accountNumber: string, orderId: number): Promise<unknown>;
  replaceOrder(
    accountNumber: string,
    orderId: number,
    replacementOrder: Partial<OrderRequest>,
  ): Promise<Order>;
  editOrder(
    accountNumber: string,
    orderId: number,
    order: Partial<OrderRequest>,
  ): Promise<Order>;
  getLiveOrders(accountNumber: string): Promise<Order[]>;
  getOrders(accountNumber: string, queryParams?: object): Promise<Order[]>;
  createOrder(accountNumber: string, order: OrderRequest): Promise<PlacedOrderResponse>;
  createComplexOrder(accountNumber: string, order: object): Promise<PlacedOrderResponse>;
  postOrderDryRun(accountNumber: string, order: OrderRequest): Promise<PlacedOrderResponse>;
  getLiveOrdersForCustomer(customerId: string): Promise<Order[]>;
  getCustomerOrders(customerId: string, queryParams?: object): Promise<Order[]>;
}

export function createTypedOrderService(rawOrderService: RawOrderService): TypedOrderService {
  return {
    async postReconfirmOrder(accountNumber: string, orderId: number) {
      return (await rawOrderService.postReconfirmOrder(
        accountNumber,
        orderId,
      )) as PlacedOrderResponse;
    },
    async replacementOrderDryRun(
      accountNumber: string,
      orderId: number,
      replacementOrder: Partial<OrderRequest>,
    ) {
      return (await rawOrderService.replacementOrderDryRun(
        accountNumber,
        orderId,
        replacementOrder,
      )) as PlacedOrderResponse;
    },
    async getOrder(accountNumber: string, orderId: number) {
      return (await rawOrderService.getOrder(accountNumber, orderId)) as Order;
    },
    async cancelOrder(accountNumber: string, orderId: number) {
      return (await rawOrderService.cancelOrder(accountNumber, orderId)) as Order;
    },
    async cancelComplexOrder(accountNumber: string, orderId: number) {
      return rawOrderService.cancelComplexOrder(accountNumber, orderId);
    },
    async replaceOrder(
      accountNumber: string,
      orderId: number,
      replacementOrder: Partial<OrderRequest>,
    ) {
      return (await rawOrderService.replaceOrder(
        accountNumber,
        orderId,
        replacementOrder,
      )) as Order;
    },
    async editOrder(
      accountNumber: string,
      orderId: number,
      order: Partial<OrderRequest>,
    ) {
      return (await rawOrderService.editOrder(accountNumber, orderId, order)) as Order;
    },
    async getLiveOrders(accountNumber: string) {
      return (await rawOrderService.getLiveOrders(accountNumber)) as Order[];
    },
    async getOrders(accountNumber: string, queryParams?: object) {
      return (await rawOrderService.getOrders(accountNumber, queryParams)) as Order[];
    },
    async createOrder(accountNumber: string, order: OrderRequest) {
      return (await rawOrderService.createOrder(
        accountNumber,
        order,
      )) as PlacedOrderResponse;
    },
    async createComplexOrder(accountNumber: string, order: object) {
      return (await rawOrderService.createComplexOrder(
        accountNumber,
        order,
      )) as PlacedOrderResponse;
    },
    async postOrderDryRun(accountNumber: string, order: OrderRequest) {
      return (await rawOrderService.postOrderDryRun(
        accountNumber,
        order,
      )) as PlacedOrderResponse;
    },
    async getLiveOrdersForCustomer(customerId: string) {
      return (await rawOrderService.getLiveOrdersForCustomer(customerId)) as Order[];
    },
    async getCustomerOrders(customerId: string, queryParams?: object) {
      return (await rawOrderService.getCustomerOrders(customerId, queryParams)) as Order[];
    },
  };
}
