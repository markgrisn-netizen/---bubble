package com.paneltranslate.browser

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Clean HTTP bridge to PanelTranslate AI backend (`/api/mobile/share-import`).
 * Uploads user-captured images or shared CBZ/ZIP archives directly — never forwards
 * website cookies, passwords, or session headers, and never invokes source_fetch.
 */
object PanelApiClient {
    data class ImportResult(
        val ok: Boolean,
        val chapterId: String? = null,
        val pageCount: Int = 0,
        val error: String? = null
    )

    fun uploadCapturedImages(
        serverBaseUrl: String,
        chapterTitle: String,
        images: List<Pair<String, Pair<Int, Int>>>,
        sourcePlatform: String = "android_webview"
    ): ImportResult {
        val payload = JSONObject().apply {
            put("chapterTitle", chapterTitle)
            put("sourcePlatform", sourcePlatform)
            put("images", JSONArray().apply {
                images.forEachIndexed { idx, (dataUrl, dims) ->
                    put(JSONObject().apply {
                        put("dataUrl", dataUrl)
                        put("filename", "page_${idx + 1}.png")
                        put("width", dims.first)
                        put("height", dims.second)
                    })
                }
            })
        }
        return postJson("$serverBaseUrl/api/mobile/share-import", payload)
    }

    fun uploadSharedArchive(
        serverBaseUrl: String,
        chapterTitle: String,
        archiveFilename: String,
        archiveBase64: String
    ): ImportResult {
        val payload = JSONObject().apply {
            put("chapterTitle", chapterTitle)
            put("sourcePlatform", "android_share_intent")
            put("archiveFilename", archiveFilename)
            put("archiveBase64", archiveBase64)
        }
        return postJson("$serverBaseUrl/api/mobile/share-import", payload)
    }

    private fun postJson(endpoint: String, body: JSONObject): ImportResult {
        val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 15000
            readTimeout = 30000
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        return try {
            val bytes = body.toString().toByteArray(StandardCharsets.UTF_8)
            BufferedOutputStream(conn.outputStream).use { out ->
                out.write(bytes)
                out.flush()
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val raw = stream?.bufferedReader()?.readText().orEmpty()
            val parsed = runCatching { JSONObject(raw) }.getOrNull()
            if (code in 200..299) {
                val chId = parsed?.optJSONObject("chapter")?.optString("id")
                val count = parsed?.optJSONArray("pages")?.length() ?: 0
                ImportResult(ok = true, chapterId = chId, pageCount = count)
            } else {
                ImportResult(
                    ok = false,
                    error = parsed?.optString("error") ?: "HTTP $code"
                )
            }
        } catch (ex: Exception) {
            ImportResult(ok = false, error = ex.message ?: "Network error")
        } finally {
            conn.disconnect()
        }
    }
}
