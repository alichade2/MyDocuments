package com.alichade.mydocs;

import android.provider.Settings;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.List;

/**
 * Google Play Billing for the one-time "MyDocs Pro" product. This class only talks to Google Play: it returns what Play says
 * (product details, purchases, results). It never decides whether Pro is unlocked; that is the entitlement layer in the page
 * (entitlements.js / billing.js), which verifies a purchase before acknowledging it and before granting anything.
 */
@CapacitorPlugin(name = "PlayBilling")
public class PlayBillingPlugin extends Plugin implements PurchasesUpdatedListener {
    private BillingClient client;
    private ProductDetails details;
    private PluginCall pendingPurchase;

    @Override
    public void load() {
        client = BillingClient.newBuilder(getContext())
            .setListener(this)
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .build();
    }

    private interface Ready { void run(); }

    /** Runs `then` once Google Play is connected; rejects the call otherwise. */
    private void connected(final PluginCall call, final Ready then) {
        if (client.isReady()) { then.run(); return; }
        client.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult result) {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) then.run();
                else call.reject("Google Play Billing is not available", codeOf(result));
            }

            @Override
            public void onBillingServiceDisconnected() { /* reconnected on the next call */ }
        });
    }

    private static String codeOf(BillingResult result) {
        switch (result.getResponseCode()) {
            case BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE:
            case BillingClient.BillingResponseCode.NETWORK_ERROR:
            case BillingClient.BillingResponseCode.SERVICE_DISCONNECTED:
            case BillingClient.BillingResponseCode.SERVICE_TIMEOUT:
                return "OFFLINE";
            case BillingClient.BillingResponseCode.BILLING_UNAVAILABLE:
            case BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED:
                return "UNAVAILABLE";
            case BillingClient.BillingResponseCode.ITEM_UNAVAILABLE:
                return "PRODUCT_NOT_FOUND";
            case BillingClient.BillingResponseCode.USER_CANCELED:
                return "CANCELED";
            case BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED:
                return "ALREADY_OWNED";
            default:
                return "ERROR";
        }
    }

    /** A stable id of this device (the same after reinstalling this app): promo and purchase tokens are bound to it. */
    @PluginMethod
    public void deviceId(PluginCall call) {
        try {
            String androidId = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(((androidId == null ? "" : androidId) + ":" + getContext().getPackageName()).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 16; i++) sb.append(String.format("%02x", hash[i]));
            JSObject res = new JSObject();
            res.put("deviceId", sb.toString());
            call.resolve(res);
        } catch (Exception e) {
            call.reject("Unavailable", "ERROR");
        }
    }

    @PluginMethod
    public void connect(final PluginCall call) {
        connected(call, () -> { JSObject res = new JSObject(); res.put("ready", true); call.resolve(res); });
    }

    /** Name, description and the formatted price exactly as Google Play shows them for this user. Nothing is hard-coded. */
    @PluginMethod
    public void getProduct(final PluginCall call) {
        final String productId = call.getString("productId");
        if (productId == null) { call.reject("productId is required", "ERROR"); return; }
        connected(call, () -> {
            QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
                .setProductList(Collections.singletonList(QueryProductDetailsParams.Product.newBuilder().setProductId(productId).setProductType(BillingClient.ProductType.INAPP).build()))
                .build();
            client.queryProductDetailsAsync(params, (result, queryResult) -> {
                List<ProductDetails> list = queryResult.getProductDetailsList();
                if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) { call.reject("Product query failed", codeOf(result)); return; }
                if (list == null || list.isEmpty() || list.get(0).getOneTimePurchaseOfferDetails() == null) { call.reject("Product not found", "PRODUCT_NOT_FOUND"); return; }
                details = list.get(0);
                ProductDetails.OneTimePurchaseOfferDetails offer = details.getOneTimePurchaseOfferDetails();
                JSObject res = new JSObject();
                res.put("productId", details.getProductId());
                res.put("name", details.getName());
                res.put("description", details.getDescription());
                res.put("formattedPrice", offer.getFormattedPrice());
                res.put("priceAmountMicros", offer.getPriceAmountMicros());
                res.put("currencyCode", offer.getPriceCurrencyCode());
                call.resolve(res);
            });
        });
    }

    /** Opens Google Play's purchase screen. Resolves { status: purchased | pending | cancelled | owned | error, purchases }. */
    @PluginMethod
    public void purchase(final PluginCall call) {
        if (details == null) { call.reject("Load the product first", "PRODUCT_NOT_FOUND"); return; }
        if (pendingPurchase != null) { call.reject("A purchase is already in progress", "BUSY"); return; }
        connected(call, () -> {
            BillingFlowParams params = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(Collections.singletonList(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(details).build()))
                .build();
            pendingPurchase = call;
            getActivity().runOnUiThread(() -> {
                BillingResult launch = client.launchBillingFlow(getActivity(), params);
                if (launch.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    PluginCall failed = pendingPurchase;
                    pendingPurchase = null;
                    if (failed != null) failed.reject("The purchase screen could not be opened", codeOf(launch));
                }
            });
        });
    }

    @Override
    public void onPurchasesUpdated(@NonNull BillingResult result, @Nullable List<Purchase> purchases) {
        PluginCall call = pendingPurchase;
        pendingPurchase = null;
        if (call == null) return; // e.g. a purchase completed outside the app: the next queryPurchases picks it up
        JSObject res = new JSObject();
        int code = result.getResponseCode();
        if (code == BillingClient.BillingResponseCode.OK && purchases != null && !purchases.isEmpty()) {
            res.put("purchases", toJson(purchases));
            res.put("status", purchases.get(0).getPurchaseState() == Purchase.PurchaseState.PENDING ? "pending" : "purchased");
        } else if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
            res.put("status", "cancelled");
        } else if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) {
            res.put("status", "owned");
        } else {
            res.put("status", "error");
            res.put("code", codeOf(result));
        }
        call.resolve(res);
    }

    /** What Google Play says this account owns (one-time products). Used at launch and for Restore Purchases. */
    @PluginMethod
    public void queryPurchases(final PluginCall call) {
        connected(call, () -> client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build(), (result, purchases) -> {
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) { call.reject("Purchases could not be read", codeOf(result)); return; }
            JSObject res = new JSObject();
            res.put("purchases", toJson(purchases));
            call.resolve(res);
        }));
    }

    /** Acknowledges a purchase (Google refunds unacknowledged purchases after 3 days). Called only after the purchase is verified. */
    @PluginMethod
    public void acknowledge(final PluginCall call) {
        final String token = call.getString("purchaseToken");
        if (token == null) { call.reject("purchaseToken is required", "ERROR"); return; }
        connected(call, () -> client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build(), result -> {
            if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) call.resolve();
            else call.reject("Could not acknowledge the purchase", codeOf(result));
        }));
    }

    private static JSArray toJson(@Nullable List<Purchase> purchases) {
        JSArray array = new JSArray();
        if (purchases == null) return array;
        for (Purchase p : purchases) {
            JSObject o = new JSObject();
            o.put("productId", p.getProducts().isEmpty() ? "" : p.getProducts().get(0));
            o.put("purchaseToken", p.getPurchaseToken());
            o.put("orderId", p.getOrderId());
            o.put("state", p.getPurchaseState() == Purchase.PurchaseState.PURCHASED ? "purchased" : p.getPurchaseState() == Purchase.PurchaseState.PENDING ? "pending" : "unspecified");
            o.put("acknowledged", p.isAcknowledged());
            o.put("originalJson", p.getOriginalJson());
            o.put("signature", p.getSignature());
            o.put("purchaseTime", p.getPurchaseTime());
            array.put(o);
        }
        return array;
    }
}
