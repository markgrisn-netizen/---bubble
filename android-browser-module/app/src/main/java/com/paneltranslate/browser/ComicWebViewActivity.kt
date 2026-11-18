package com.paneltranslate.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

/**
 * Native Android WebView Comic Browser & Faqqa Photo Picker host.
 * - Full JavaScript rendering & manual login inside WebView
 * - Native Android Photo Picker via WebChromeClient.onShowFileChooser (PickMultipleVisualMedia,
 *   no broad READ_MEDIA_IMAGES / storage permissions required)
 * - Permanent "Import Chapter" action collecting rendered DOM/Canvas images via natural scroll
 * - Screenshot fallback when sites render via protected canvas or custom shaders
 * - Honest HTTP 403 detection & "Open in External Browser" fallback
 * - Privacy toggle (clear cookies, cache, and history)
 */
class ComicWebViewActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var urlBar: EditText
    private var serverBaseUrl: String = "http://10.0.2.2:3000"
    private var incognitoMode: Boolean = false
    private var lastHttpStatus: Int = 200
    private var pendingFilePathCallback: ValueCallback<Array<Uri>>? = null

    private val pickMultipleImagesLauncher = registerForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia()
    ) { uris ->
        deliverFileChooserResult(uris.toTypedArray())
    }

    private val pickSingleImageLauncher = registerForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        deliverFileChooserResult(if (uri != null) arrayOf(uri) else emptyArray())
    }

    private val fallbackFileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uris = extractUrisFromActivityResult(result.resultCode, result.data)
        deliverFileChooserResult(uris)
    }

    private fun deliverFileChooserResult(uris: Array<Uri>) {
        val callback = pendingFilePathCallback
        pendingFilePathCallback = null
        callback?.onReceiveValue(if (uris.isEmpty()) null else uris)
    }

    private fun extractUrisFromActivityResult(resultCode: Int, data: Intent?): Array<Uri> {
        if (resultCode != Activity.RESULT_OK || data == null) return emptyArray()
        val clip = data.clipData
        if (clip != null && clip.itemCount > 0) {
            return Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
        }
        val single = data.data
        return if (single != null) arrayOf(single) else emptyArray()
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }

        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(16, 16, 16, 12)
        }

        val backBtn = Button(this).apply {
            text = "<"
            setOnClickListener { if (webView.canGoBack()) webView.goBack() }
        }
        val forwardBtn = Button(this).apply {
            text = ">"
            setOnClickListener { if (webView.canGoForward()) webView.goForward() }
        }
        urlBar = EditText(this).apply {
            hint = "https://globalcomix.com"
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            setSingleLine(true)
        }
        val goBtn = Button(this).apply {
            text = "Go"
            setOnClickListener { navigateTo(urlBar.text.toString()) }
        }
        val importBtn = Button(this).apply {
            text = getString(R.string.import_chapter)
            setOnClickListener { collectVisibleImagesAndSend() }
        }
        val externalBtn = Button(this).apply {
            text = "Ext"
            setOnClickListener {
                val current = webView.url ?: return@setOnClickListener
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(current)))
            }
        }
        val privacyBtn = Button(this).apply {
            text = "Private"
            setOnClickListener {
                incognitoMode = !incognitoMode
                if (incognitoMode) clearPrivacyState()
                Toast.makeText(
                    this@ComicWebViewActivity,
                    if (incognitoMode) "Private mode ON (state cleared)" else "Standard mode",
                    Toast.LENGTH_SHORT
                ).show()
            }
        }

        toolbar.addView(backBtn)
        toolbar.addView(forwardBtn)
        toolbar.addView(urlBar)
        toolbar.addView(goBtn)
        toolbar.addView(importBtn)
        toolbar.addView(externalBtn)
        toolbar.addView(privacyBtn)

        webView = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = !incognitoMode
                allowContentAccess = true
                useWideViewPort = true
                loadWithOverviewMode = true
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?
                ): Boolean {
                    pendingFilePathCallback?.onReceiveValue(null)
                    pendingFilePathCallback = filePathCallback

                    val acceptTypes = fileChooserParams?.acceptTypes
                        .orEmpty()
                        .map { it.trim().lowercase() }
                        .filter { it.isNotEmpty() }

                    val isImagePicker = acceptTypes.isNotEmpty() && acceptTypes.all { type ->
                        type.startsWith("image/") ||
                            type == ".jpg" ||
                            type == ".jpeg" ||
                            type == ".png" ||
                            type == ".webp" ||
                            type == ".heic" ||
                            type == ".gif"
                    }

                    val allowMultiple =
                        fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE

                    if (isImagePicker) {
                        try {
                            val request = PickVisualMediaRequest(
                                ActivityResultContracts.PickVisualMedia.ImageOnly
                            )
                            if (allowMultiple) {
                                pickMultipleImagesLauncher.launch(request)
                            } else {
                                pickSingleImageLauncher.launch(request)
                            }
                            return true
                        } catch (_: ActivityNotFoundException) {
                            // Fall through to system document/file chooser below
                        }
                    }

                    return try {
                        val chooserIntent = fileChooserParams?.createIntent() ?: Intent(
                            Intent.ACTION_GET_CONTENT
                        ).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = if (isImagePicker) "image/*" else "*/*"
                            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple)
                        }
                        fallbackFileChooserLauncher.launch(chooserIntent)
                        true
                    } catch (_: ActivityNotFoundException) {
                        pendingFilePathCallback?.onReceiveValue(null)
                        pendingFilePathCallback = null
                        false
                    }
                }
            }
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    if (!url.isNullOrBlank()) urlBar.setText(url)
                }

                override fun onReceivedHttpError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    errorResponse: WebResourceResponse?
                ) {
                    super.onReceivedHttpError(view, request, errorResponse)
                    if (request?.isForMainFrame == true) {
                        lastHttpStatus = errorResponse?.statusCode ?: 403
                        if (lastHttpStatus == 403) {
                            Toast.makeText(
                                this@ComicWebViewActivity,
                                "HTTP 403 Blocked — use manual verification or Share from external browser.",
                                Toast.LENGTH_LONG
                            ).show()
                        }
                    }
                }
            }
            addJavascriptInterface(PanelBridge(), "PanelBridge")
        }

        root.addView(toolbar)
        root.addView(webView)
        setContentView(root)

        val initialUrl = intent?.dataString ?: "https://globalcomix.com"
        navigateTo(initialUrl)
    }

    private fun navigateTo(raw: String) {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return
        val normalized = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            trimmed
        } else {
            "https://$trimmed"
        }
        lastHttpStatus = 200
        webView.loadUrl(normalized)
    }

    private fun clearPrivacyState() {
        webView.clearHistory()
        webView.clearCache(true)
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
    }

    private fun collectVisibleImagesAndSend() {
        if (lastHttpStatus == 403) {
            Toast.makeText(
                this,
                "Cannot import from HTTP 403 response; complete verification or share locally.",
                Toast.LENGTH_LONG
            ).show()
            return
        }

        // Scroll slightly to trigger lazy loading, then extract visible <img>/<canvas> frames
        val script = """
            (function() {
              window.scrollBy(0, 600);
              var out = [];
              var imgs = Array.from(document.querySelectorAll('img'));
              imgs.forEach(function(img) {
                var w = img.naturalWidth || img.clientWidth;
                var h = img.naturalHeight || img.clientHeight;
                if (w < 200 || h < 200) return;
                try {
                  var c = document.createElement('canvas');
                  c.width = w; c.height = h;
                  c.getContext('2d').drawImage(img, 0, 0, w, h);
                  out.push({ dataUrl: c.toDataURL('image/png'), width: w, height: h });
                } catch(e) {}
              });
              window.PanelBridge.onImagesCollected(JSON.stringify(out), document.title || 'Chapter');
            })();
        """.trimIndent()
        webView.evaluateJavascript(script, null)
    }

    private fun captureScreenshotFallback(): Pair<String, Pair<Int, Int>> {
        val w = webView.width.coerceAtLeast(1)
        val h = webView.height.coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        webView.draw(canvas)
        val stream = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, stream)
        val b64 = Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
        return "data:image/png;base64,$b64" to (w to h)
    }

    inner class PanelBridge {
        @JavascriptInterface
        fun onImagesCollected(jsonPayload: String, title: String) {
            val arr = runCatching { JSONArray(jsonPayload) }.getOrNull() ?: JSONArray()
            val list = mutableListOf<Pair<String, Pair<Int, Int>>>()
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                val dataUrl = obj.optString("dataUrl")
                if (dataUrl.startsWith("data:image/")) {
                    list.add(dataUrl to (obj.optInt("width", 900) to obj.optInt("height", 1200)))
                }
            }
            if (list.isEmpty()) {
                // Screenshot fallback on main thread when page uses cross-origin tainted canvases
                runOnUiThread {
                    val shot = captureScreenshotFallback()
                    sendListInBackground(title, listOf(shot))
                }
            } else {
                sendListInBackground(title, list)
            }
        }
    }

    private fun sendListInBackground(title: String, pages: List<Pair<String, Pair<Int, Int>>>) {
        thread {
            val res = PanelApiClient.uploadCapturedImages(serverBaseUrl, title, pages)
            runOnUiThread {
                Toast.makeText(
                    this,
                    if (res.ok) "Imported ${res.pageCount} page(s) to Translator"
                    else "Import failed: ${res.error}",
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }
}
