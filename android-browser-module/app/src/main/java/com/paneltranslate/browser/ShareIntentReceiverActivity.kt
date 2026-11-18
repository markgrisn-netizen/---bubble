package com.paneltranslate.browser

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import kotlin.concurrent.thread

/**
 * Handles Android Share Sheet (ACTION_SEND / ACTION_SEND_MULTIPLE) for comic images,
 * CBZ/ZIP archives, and PDFs shared from external comic readers or mobile browsers.
 */
class ShareIntentReceiverActivity : AppCompatActivity() {

    private val serverBaseUrl = "http://10.0.2.2:3000"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleIncomingShare(intent)
    }

    private fun handleIncomingShare(shareIntent: Intent?) {
        if (shareIntent == null) {
            finish()
            return
        }

        val uris = mutableListOf<Uri>()
        when (shareIntent.action) {
            Intent.ACTION_SEND -> {
                val single = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    shareIntent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    shareIntent.getParcelableExtra(Intent.EXTRA_STREAM)
                }
                if (single != null) uris.add(single)
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                val multi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    shareIntent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    shareIntent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
                }
                if (multi != null) uris.addAll(multi)
            }
        }

        if (uris.isEmpty()) {
            Toast.makeText(this, "No shared files found", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        val mimeType = shareIntent.type.orEmpty().lowercase()
        val subject = shareIntent.getStringExtra(Intent.EXTRA_SUBJECT) ?: "Shared Comic Chapter"

        thread {
            val result = if (mimeType.contains("zip") || mimeType.contains("comicbook") || uris.first().toString().endsWith(".cbz", true)) {
                val bytes = contentResolver.openInputStream(uris.first())?.use { it.readBytes() } ?: ByteArray(0)
                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                PanelApiClient.uploadSharedArchive(
                    serverBaseUrl = serverBaseUrl,
                    chapterTitle = subject,
                    archiveFilename = "shared_issue.cbz",
                    archiveBase64 = b64
                )
            } else {
                val images = uris.mapNotNull { uri ->
                    val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@mapNotNull null
                    val mime = contentResolver.getType(uri) ?: "image/jpeg"
                    val dataUrl = "data:$mime;base64,${Base64.encodeToString(bytes, Base64.NO_WRAP)}"
                    dataUrl to (900 to 1200)
                }
                PanelApiClient.uploadCapturedImages(
                    serverBaseUrl = serverBaseUrl,
                    chapterTitle = subject,
                    images = images,
                    sourcePlatform = "android_share_intent"
                )
            }

            runOnUiThread {
                Toast.makeText(
                    this,
                    if (result.ok) "Shared ${result.pageCount} page(s) to Faqqa"
                    else "Share import failed: ${result.error}",
                    Toast.LENGTH_LONG
                ).show()
                finish()
            }
        }
    }
}
