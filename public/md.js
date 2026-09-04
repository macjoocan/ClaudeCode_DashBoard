// 대화 보기용 최소 마크다운 렌더러.
// HTML 이스케이프를 먼저 하고, 코드 부분은 자리표시자로 빼둔 뒤 나머지 텍스트에만
// 강조/헤딩/불릿 변환을 적용한다 (코드 블록 안의 ** 가 볼드로 먹히지 않게).
(function () {
  // 본문에 나올 수 없는 제어문자를 자리표시자 경계로 쓴다.
  // 소스에 제어문자를 직접 넣지 않고 코드로 만든다.
  var MARK = String.fromCharCode(1);
  var STRIP = new RegExp(MARK, 'g');
  var RESTORE = new RegExp(MARK + '(\\d+)' + MARK, 'g');

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function md(src) {
    var keep = [];
    function stash(html) {
      keep.push(html);
      return MARK + (keep.length - 1) + MARK;
    }

    // 원본에 섞여 있을 수 있는 경계문자를 먼저 없앤다
    var t = escHtml(String(src == null ? '' : src).replace(STRIP, ''));

    // ```펜스 코드블록```
    t = t.replace(/```[a-zA-Z0-9_+.-]*\r?\n?([\s\S]*?)```/g, function (m, code) {
      return stash('<code class="blk">' + code.replace(/\s+$/, '') + '</code>');
    });

    // `인라인 코드`
    t = t.replace(/`([^`\r\n]+)`/g, function (m, code) {
      return stash('<code>' + code + '</code>');
    });

    // # 헤딩
    t = t.replace(/^#{1,6}[ \t]+(.+)$/gm, '<b class="h">$1</b>');

    // **볼드**
    t = t.replace(/\*\*([^*\r\n]+)\*\*/g, '<strong>$1</strong>');

    // - 불릿 / * 불릿
    t = t.replace(/^([ \t]*)[-*][ \t]+/gm, '$1· ');

    return t.replace(RESTORE, function (m, i) { return keep[Number(i)]; });
  }

  window.escHtml = escHtml;
  window.md = md;
})();
