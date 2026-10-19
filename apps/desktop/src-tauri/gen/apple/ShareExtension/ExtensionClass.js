// Safari's NSExtensionJavaScriptPreprocessingFile: runs in the shared page
// and hands the extension the richest capture available in-page — title,
// URL, the user's text selection, and the meta/OpenGraph description. The
// description lands in the envelope's `metaDescription`, so an offline
// capture still saves with one; the app's enrichment pass replaces it later.
//
// Keys with null/undefined values must be omitted entirely: they break the
// NSSecureCoding → NSDictionary bridge on the Swift side (V1 hit this on
// pages with no description).

var ExtensionClass = function () {}

ExtensionClass.prototype = {
  run: function (args) {
    var pick = function (selector) {
      var tag = document.querySelector(selector)
      return (tag && tag.content) || null
    }
    var description =
      pick('meta[property="og:description"]') ||
      pick('meta[name="og:description"]') ||
      pick('meta[name="description"]')

    // getSelection() can be null (e.g. in some frame contexts); a throw here
    // would skip completionFunction and fail the whole share.
    var selection = window.getSelection()

    var content = {
      title: document.title,
      url: window.location.href,
      selection: (selection && selection.toString()) || '',
    }
    if (description) {
      content.description = description
    }

    args.completionFunction(content)
  },
}

// The global Safari looks up by name to run the preprocessor.
var ExtensionPreprocessingJS = new ExtensionClass()
